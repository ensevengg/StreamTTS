# StreamTTS Privacy Policy

**Last Updated:** October 2026

## Overview

StreamTTS is a free, open-source desktop application that reads chat messages from Twitch and YouTube during live streams using text-to-speech. This privacy policy explains how the app handles your data.

## Information We Collect

### OAuth Tokens
When you connect your Twitch or YouTube account, StreamTTS receives an access token and a refresh token. They are stored **in your operating system's keychain on your device** and are only ever sent to the service they belong to (Twitch or Google), to read your chat and renew the login.

### Chat Messages
StreamTTS reads chat messages from your connected Twitch and YouTube channels in real-time to convert them to speech. These messages are:
- Processed entirely on your local device
- **NOT stored** after being read
- **NOT transmitted** to any external servers

## Permissions We Request

All permissions are read-only. StreamTTS cannot post, moderate, upload, edit or delete anything.

### Twitch
- `chat:read` - Read chat messages from your channel
- `channel:read:subscriptions` - See new and gifted subscriptions, for alerts
- `channel:read:redemptions` - See channel point redemptions, for alerts

### YouTube
- `https://www.googleapis.com/auth/youtube.readonly` - Find your live broadcast and read its chat, Super Chats and memberships

Older versions of StreamTTS asked Google for broader YouTube access. If you used one, you can remove the old grant at [Google Account Permissions](https://myaccount.google.com/permissions) and log in again.

## Data Storage

All data is stored locally on your device:
- OAuth tokens and your ElevenLabs API key are stored in your operating system's secure credential storage
- Alert settings are stored in your user profile directory
- No data is uploaded to external servers

## Third-Party Services

StreamTTS communicates directly with:
- **Twitch** - To log in, read chat messages and receive alert events
- **YouTube Data API** - To read live chat messages
- **ElevenLabs** - Only if you choose it as the voice: the text of messages being read aloud is sent to ElevenLabs with your API key
- **GitHub** - To check for app updates

We do not use any analytics, tracking, or advertising services.

## Data Sharing

We do **NOT**:
- Sell your data
- Share your data with third parties
- Store your data on external servers
- Track your usage

## Account Disconnection

You can log out at any time from the Connections tab in the app. This removes the stored tokens from your device. To also revoke StreamTTS's access on the provider's side, use the links below.

You can also revoke access directly from:
- [Twitch Connections Settings](https://www.twitch.tv/settings/connections)
- [Google Account Permissions](https://myaccount.google.com/permissions)

## Open Source

StreamTTS is open source. You can review the complete source code at:
https://github.com/ensevengg/StreamTTS

## Changes to This Policy

We may update this privacy policy from time to time. Changes will be posted in this file with an updated date.

## Contact

For questions about this privacy policy, please open an issue on the GitHub repository.

---

## Summary

- Your data stays on your device
- We only request read-only permissions
- No analytics, no tracking, no servers of our own
- Open source and auditable
