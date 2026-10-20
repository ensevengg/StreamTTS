# StreamTTS

**Desktop TTS for streamers.** Reads Twitch and YouTube chat messages aloud during live streams.

[Download](https://github.com/ensevengg/StreamTTS/releases) · [Report Bug](https://github.com/ensevengg/StreamTTS/issues) · [Privacy](PRIVACY.md) · [OBS Setup](OBS_INTEGRATION_GUIDE.md)

## Features

- **Twitch + YouTube** — Twitch chat over IRC (tmi.js), YouTube live chat streamed from the Data API
- **Read-only logins** — Twitch `chat:read` plus read-only sub/redemption scopes; YouTube `youtube.readonly` only
- **Survives stream trouble** — chat reconnects on its own after network drops, Twitch maintenance and YouTube stream crashes
- **Dual TTS Engine** — Browser Web Speech API (free, unlimited) or ElevenLabs (premium)
- **`!г` and `!r` commands** — viewers start a message with `!г` to have it read in Russian or `!r` for English, each with its own voice
- **Viewer limits** — per-viewer cooldown, message length cap, links read as "link", Skip and Clear queue
- **Alerts** — Twitch subs, gifted subs and channel points (EventSub WebSocket); YouTube Super Chats and memberships
- **Privacy-First** — tokens and settings in the OS keychain; no telemetry, no analytics
- **Cross-Platform** — Windows, macOS, Linux (Tauri v2)

## Quick Start

```bash
git clone https://github.com/ensevengg/StreamTTS.git
cd StreamTTS
cp .env.example .env   # then fill in your OAuth client IDs (see below)
npm install
npm run tauri:dev
```

## Tech Stack

| Layer | |
|-------|---|
| Desktop | Tauri v2, Rust (Axum loopback server for the Google redirect, tonic gRPC client for YouTube chat) |
| Frontend | React 18, TypeScript, Tailwind CSS, Vite |
| UI | shadcn/ui, Radix primitives, Lucide icons |
| State | Zustand |
| Chat | tmi.js (Twitch IRC), Twitch EventSub WebSocket, YouTube Data API v3 (`streamList` over gRPC) |
| TTS | Web Speech API, ElevenLabs REST API |
| Tests | Vitest, `cargo test` |

## Architecture

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

## Project Structure

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

## OAuth Setup

Copy `.env.example` to `.env` at the project root. `src-tauri/build.rs`
compiles the values into the binary, so installed copies need no `.env`.

**Twitch:** [Developer Console](https://dev.twitch.tv/console) → register an
application with **Client Type: Public**, then set `TWITCH_CLIENT_ID`. Login
uses Twitch's Device Code Flow, so there is no client secret and no redirect URL
to configure.

**YouTube:** [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
→ enable **YouTube Data API v3** → create an OAuth client of type **Desktop
app** → set `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`. On the consent
screen, add only the `.../auth/youtube.readonly` scope. Google treats a desktop
client's secret as non-confidential.

**YouTube API quota:** the YouTube Data API is free, but each Google project
gets 10,000 units/day, shared by everyone using your client ID. StreamTTS reads
chat with `liveChatMessages.streamList`: one long-lived connection that costs 5
units each time it opens, rather than a 5-unit poll every few seconds. If
streaming can't connect (for example on a network that blocks gRPC), it falls
back to polling at most every 5 seconds, which uses far more quota. If usage
grows, Google's free *Audit and Quota Extension* form raises the limit.

## Scripts

| Command | |
|---------|-|
| `npm run dev` | Vite dev server (localhost only) |
| `npm run tauri:dev` | Full desktop app in dev mode |
| `npm run tauri:build` | Production build |
| `npm run test` | Frontend tests (Vitest) |
| `cd src-tauri && cargo test` | Backend tests |
| `npm run lint` | ESLint |
| `npm run clean` | Remove `dist/` |

Platform-specific builds: `tauri:build:win`, `tauri:build:mac`, `tauri:build:linux`.

## Releases and updates

The updater reads `latest.json` from the latest GitHub release of
`ensevengg/StreamTTS` and only installs updates signed with the key whose public
half is in `tauri.conf.json`. Publish `latest.json` with each release (the
Tauri GitHub Action generates it) and keep the private signing key secret.

## Requirements

- Node.js 18+, Rust 1.77+, platform build tools (VC++ on Windows, Xcode CLT on macOS, `libwebkit2gtk-4.1-dev` on Linux)

## License

MIT — see [LICENSE](LICENSE).
