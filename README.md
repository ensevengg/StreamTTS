# StreamTTS

**Reads your Twitch and YouTube chat aloud while you stream.**

[Download](https://github.com/ensevengg/StreamTTS/releases) · [OBS Setup](OBS_INTEGRATION_GUIDE.md) · [Privacy](PRIVACY.md) · [Report a Bug](https://github.com/ensevengg/StreamTTS/issues)

## Features

- **Chat commands:** viewers start a message with
  - `!г` for a Russian voice
  - `!r` for an English voice
- **Platforms:** Twitch and YouTube
- **Voices:**
  - Browser voices: free, unlimited
  - ElevenLabs: premium, needs an API key
- **Alerts:**
  - Twitch: subs, gifted subs, channel points
  - YouTube: Super Chats, memberships
- **Stays connected:** recovers from network drops, Twitch maintenance and YouTube stream crashes
- **Viewer limits:**
  - per-viewer cooldown
  - message length cap
  - links read as "link"
  - Skip and Clear queue
- **Privacy:**
  - read-only logins
  - logins and keys stored in the OS keychain
  - no telemetry
- **Runs on:** Windows, macOS, Linux

## For streamers

1. Download StreamTTS from [Releases](https://github.com/ensevengg/StreamTTS/releases).
2. Log in with Twitch or YouTube.
3. Open **Connections** and click **Connect to chat**.
4. Viewers type `!г привет` or `!r hello`.
5. Send the audio to your stream with the [OBS guide](OBS_INTEGRATION_GUIDE.md).

## For developers

### Quick start

```bash
git clone https://github.com/ensevengg/StreamTTS.git
cd StreamTTS
cp .env.example .env   # fill in the OAuth clients, see below
npm install
npm run tauri:dev
```

### Requirements

- Node.js 18+
- Rust 1.77+
- Platform build tools:
  - Windows: VC++ build tools
  - macOS: Xcode Command Line Tools
  - Linux: `libwebkit2gtk-4.1-dev`

### OAuth setup

- Copy `.env.example` to `.env` at the repo root.
- `src-tauri/build.rs` compiles the values into the app, so installed copies need no `.env`.

**Twitch**

1. Register an app in the [Developer Console](https://dev.twitch.tv/console).
2. Set **Client Type** to **Public**.
3. Put its ID in `TWITCH_CLIENT_ID`.

There's no client secret and no redirect URL to set up, because login uses Twitch's Device Code Flow.

**YouTube**

1. In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials), enable **YouTube Data API v3**.
2. Create an OAuth client of type **Desktop app**.
3. Put its ID and secret in `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`.
4. On the consent screen, add only the `.../auth/youtube.readonly` scope.

Google treats a desktop client's secret as non-confidential, so it's fine to compile it in.

### YouTube API quota

- The API is free, but each Google project gets **10,000 units a day**.
- That quota is **shared by everyone** using your client ID.
- Chat uses `liveChatMessages.streamList`: **5 units per connection**, not per poll.
- If a network blocks gRPC, chat falls back to polling, at most every 5 seconds. That uses far more quota.
- Need more? Google's *Audit and Quota Extension* form is free.

### Scripts

| Command | What it does |
|---------|--------------|
| `npm run tauri:dev` | Desktop app in dev mode |
| `npm run tauri:build` | Production build |
| `npm run dev` | Frontend only, in the browser (localhost) |
| `npm run test` | Frontend tests (Vitest) |
| `cd src-tauri && cargo test` | Backend tests |
| `npm run lint` | ESLint |
| `npm run clean` | Delete `dist/` |

For a specific platform, use `tauri:build:win`, `tauri:build:mac` or `tauri:build:linux`.

### Releases and updates

- The updater reads `latest.json` from the latest GitHub release of `ensevengg/StreamTTS`.
- It only installs updates signed with the key whose public half is in `tauri.conf.json`.
- Publish `latest.json` with each release. The Tauri GitHub Action generates it.
- Keep the private signing key secret.

### Tech stack

| Layer | Built with |
|-------|------------|
| Desktop | Tauri v2, Rust (Axum for the Google login redirect, tonic for YouTube chat over gRPC) |
| Frontend | React 18, TypeScript, Tailwind CSS, Vite |
| UI | shadcn/ui, Radix, Lucide icons |
| State | Zustand |
| Chat | tmi.js (Twitch IRC), Twitch EventSub, YouTube Data API v3 |
| Speech | Web Speech API, ElevenLabs |
| Tests | Vitest, `cargo test` |

<details>
<summary><strong>Architecture</strong></summary>

```
┌──────────────────────────────────────────────────────────┐
│  Frontend (React + TypeScript)                           │
│    ├── Chat sessions (services/chatSessions.ts)          │
│    │     Twitch IRC · Twitch EventSub · YouTube chat     │
│    │     each reconnects with backoff on its own         │
│    ├── Speech queue: filter → cooldown → queue → voice   │
│    └── Stores: auth, chat, settings (Zustand)            │
├──────────────────────────────────────────────────────────┤
│  Backend (Rust)                                          │
│    ├── Twitch login: Device Code Flow (no client secret) │
│    ├── YouTube login: auth code + PKCE, loopback redirect│
│    │     on localhost:3000 (falls back to a free port)   │
│    ├── Token refresh commands (IPC, never over HTTP)     │
│    ├── YouTube chat stream (gRPC streamList)             │
│    └── OS keychain access (allowlisted keys)             │
└──────────────────────────────────────────────────────────┘
```

</details>

<details>
<summary><strong>Project structure</strong></summary>

```
src/                          # React frontend
├── pages/                    # Index, Login, NotFound
├── components/               # UI components + shadcn/ui primitives
├── services/                 # chat sessions, auth, tokens, TTS queue, alerts
├── stores/                   # Zustand: auth, chat, settings
├── hooks/                    # auth callbacks, app updates, toasts
├── config/                   # constants
├── lib/                      # Tauri bridge, keychain storage, HTTP, backoff
├── test/                     # Vitest setup and desktop mocks
└── types/                    # TypeScript definitions

src-tauri/                    # Rust backend
├── src/
│   ├── lib.rs                # App init, plugins, commands
│   ├── oauth.rs              # YouTube login, loopback callback, token refresh
│   ├── twitch_auth.rs        # Twitch Device Code Flow
│   ├── youtube_stream.rs     # YouTube live chat over gRPC (streamList)
│   ├── config.rs             # OAuth client configuration
│   └── secrets.rs            # OS keychain commands
├── build.rs                  # Embeds OAuth client config at compile time
├── oauth_callback.html       # Page the browser lands on after Google login
└── tauri.conf.json
```

</details>

## License

MIT, see [LICENSE](LICENSE).
