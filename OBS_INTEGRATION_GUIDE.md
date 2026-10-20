# StreamTTS - OBS Studio Integration Guide

StreamTTS is a desktop app: it speaks through your computer's audio output like
any other program. To get that audio into your stream, capture it in OBS.

> **Not a Browser Source.** Pointing an OBS Browser Source at
> `http://localhost:8080` does not work. That address only exists while a
> developer runs `npm run dev`, and even then it opens a second, logged-out
> copy of the app inside OBS that never speaks your chat.

## Contents

- [Method 1: Application Audio Capture (recommended)](#method-1-application-audio-capture-recommended)
- [Method 2: Desktop Audio](#method-2-desktop-audio)
- [Method 3: Virtual Audio Cable (advanced)](#method-3-virtual-audio-cable-advanced)
- [Volume guidelines](#volume-guidelines)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

---

## Method 1: Application Audio Capture (recommended)

Captures only StreamTTS, so game audio, music and notifications stay separate.

### Windows (OBS 28+, Windows 10 2004 or later)

1. Start StreamTTS and play a test message (type `!г тест` in the Chat tab) so
   Windows registers it as an audio app.
2. In OBS, click **+** in **Sources** → **Application Audio Capture (BETA)**.
3. Name it `StreamTTS` and click **OK**.
4. **Window:** choose `[StreamTTS.exe]: StreamTTS`. Leave **Window Match
   Priority** on "Match title, otherwise find window of same executable".
5. Click **OK**. A `StreamTTS` meter appears in the Audio Mixer and moves when a
   message is read.

### macOS (OBS 30+, macOS 13 Ventura or later)

1. In OBS, add **macOS Screen Capture**.
2. Set **Method** to "Application Capture" and choose **StreamTTS**.
3. Enable **Capture Audio**. You can crop the video to nothing or hide the
   source; only its audio matters.
4. Grant OBS **Screen & System Audio Recording** permission when macOS asks.

If StreamTTS doesn't appear in the list or stays silent (macOS can play web
speech from a helper process), use Method 3.

### Linux (PipeWire)

Install the [obs-pipewire-audio-capture](https://github.com/dimtpap/obs-pipewire-audio-capture)
plugin, add **Application Audio Capture (PipeWire)** and pick StreamTTS. On
PulseAudio-only systems, use Method 3 with a null sink.

---

## Method 2: Desktop Audio

The quickest setup, but it captures **everything** your computer plays.

1. OBS → **Settings** → **Audio** → set **Desktop Audio** to your speakers or
   headphones.
2. StreamTTS audio is now part of the "Desktop Audio" meter.

Avoid this if you also play music you can't stream, or if you capture Desktop
Audio and StreamTTS separately: you'll hear the TTS twice.

---

## Method 3: Virtual Audio Cable (advanced)

Sends StreamTTS to its own virtual device, for full isolation on any platform.

### 1. Install a virtual device

- **Windows:** [VB-Cable](https://vb-audio.com/Cable/). Install as administrator and restart.
- **macOS:** [BlackHole](https://github.com/ExistentialAudio/BlackHole) (2ch). Restart afterwards.
- **Linux:** create a null sink: `pactl load-module module-null-sink sink_name=streamtts`
  (works on PulseAudio and PipeWire's pulse layer).

### 2. Send StreamTTS to it

- **Windows:** Settings → System → Sound → **Volume mixer**. Play a message in
  StreamTTS, then set its **Output device** to **CABLE Input**.
- **macOS:** apps can't pick an output device individually; set the system
  output to a Multi-Output Device that includes BlackHole (Audio MIDI Setup),
  or use a tool such as Loopback or SoundSource.
- **Linux:** open `pavucontrol` → **Playback**, play a message, and move
  StreamTTS (or "WebKitWebProcess") to the `streamtts` sink.

### 3. Capture it in OBS

Add an **Audio Input Capture** source and choose **CABLE Output** (Windows),
**BlackHole 2ch** (macOS) or **Monitor of streamtts** (Linux).

To hear TTS yourself as well, enable monitoring for that source in OBS
(**Edit → Advanced Audio Properties → Audio Monitoring → Monitor and Output**).

---

## Volume guidelines

| Source | Starting level | Notes |
|--------|----------------|-------|
| StreamTTS | 60–80% | Set the StreamTTS volume first, then fine-tune in OBS |
| Game audio | 40–60% | Shouldn't drown out the voice |
| Music | 20–40% | Background only |
| Microphone | 70–100% | Your voice stays the clearest element |

Alert volume is separate: **Settings → Integration Alerts → Alert Volume**.

---

## Troubleshooting

**No meter movement in OBS**
1. Make sure StreamTTS itself is audible: type `!г тест` in the Chat tab.
2. Windows: StreamTTS only shows up in Application Audio Capture and the Volume
   Mixer after it has played something once.
3. Check that the OBS source isn't muted in the Audio Mixer.

**The TTS plays twice or echoes**
You're capturing it twice, usually Desktop Audio plus an app or cable source.
Mute one of them in the OBS Audio Mixer.

**Viewers hear TTS, but you don't (or the other way round)**
- With a virtual cable, enable OBS monitoring (Method 3, step 3).
- With Application Audio Capture, StreamTTS keeps playing through your
  speakers; mute it in the system mixer if you only want it on stream.

**Messages aren't being read at all**
That's a StreamTTS issue, not OBS. Check the Connections tab: the badge shows
*Reconnecting* or *Waiting for stream* with the reason. The chat history marks
messages that were skipped (cooldown, too many from one viewer, queue full).

---

## FAQ

**Can I use StreamTTS without OBS?**
Yes. It plays through your speakers; OBS is only needed to put the audio on stream.

**Does it work with Streamlabs Desktop, vMix or XSplit?**
Yes, with any software that can capture an application, desktop audio or an
audio device.

**Does StreamTTS record my microphone?**
No. It only plays audio.

**Which voice sounds best for Russian?**
Settings → TTS Provider → Browser → Voice Selection. On Windows, "Microsoft
Pavel" is a good default. ElevenLabs sounds more natural but needs an API key.

**How do I stop one viewer from spamming the voice?**
Settings → Viewer Limits sets the longest message read and a per-viewer
cooldown. During a stream, **Skip** and **Clear queue** (Chat tab) stop what's
playing.
