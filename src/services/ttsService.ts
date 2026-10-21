import type { TTSProvider } from '@/stores/settingsStore';

const DEFAULT_VOICE_ID = 'IKne3meq5aSn9XLyUdCD';
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';
const ELEVENLABS_TIMEOUT_MS = 20_000;

export interface SpeakOptions {
  provider: TTSProvider;
  apiKey: string;
  volume: number;
  voiceName?: string;
  /** Aborting stops playback and rejects with an AbortError. */
  signal: AbortSignal;
}

const abortError = () => new DOMException('Speech was skipped', 'AbortError');

/**
 * Upper bound on how long one browser utterance may take. Chromium and
 * WebView2 sometimes stop speaking without ever firing `end`; without a
 * deadline that would block the queue for the rest of the stream.
 */
const browserSpeechTimeoutMs = (text: string): number =>
  Math.min(90_000, 10_000 + text.length * 150);

function pickVoice(voices: SpeechSynthesisVoice[], voiceName?: string): SpeechSynthesisVoice | undefined {
  if (voiceName) return voices.find(v => v.name === voiceName);
  return voices.find(v => v.name.includes('Pavel'))
    ?? voices.find(v => v.lang.startsWith('ru') || v.name.includes('Russian') || v.name.includes('русский'));
}

function speakWithBrowser(text: string, { volume, voiceName, signal }: SpeakOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) {
      reject(new Error('Speech synthesis is not available in this system webview.'));
      return;
    }
    const synth = window.speechSynthesis;
    // Clears an utterance left stuck by an earlier stall.
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.volume = volume;
    const voice = pickVoice(synth.getVoices(), voiceName);
    if (voice) utterance.voice = voice;

    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      synth.cancel();
      finish(abortError());
    };
    const watchdog = setTimeout(() => {
      synth.cancel();
      finish(new Error('Speech stalled and was stopped.'));
    }, browserSpeechTimeoutMs(text));

    signal.addEventListener('abort', onAbort, { once: true });
    utterance.onend = () => finish();
    utterance.onerror = (event) => finish(new Error(`Speech synthesis error: ${event.error}`));
    synth.speak(utterance);
  });
}

function playAudio(blob: Blob, volume: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = volume;

    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      signal.removeEventListener('abort', onAbort);
      audio.onended = null;
      audio.onerror = null;
      audio.onloadedmetadata = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(abortError());
    const stalled = () => finish(new Error('Audio playback stalled and was stopped.'));

    // The real duration is known once metadata loads; until then, a cap.
    let watchdog = setTimeout(stalled, 120_000);
    audio.onloadedmetadata = () => {
      if (!Number.isFinite(audio.duration)) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(stalled, audio.duration * 1000 + 10_000);
    };
    audio.onended = () => finish();
    audio.onerror = () => finish(new Error('Could not play the generated audio.'));
    signal.addEventListener('abort', onAbort, { once: true });
    audio.play().catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

async function speakWithElevenLabs(text: string, { apiKey, volume, signal }: SpeakOptions): Promise<void> {
  if (!apiKey) throw new Error('Set your ElevenLabs API key in Settings.');

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('ElevenLabs did not respond in time', 'TimeoutError')),
    ELEVENLABS_TIMEOUT_MS,
  );

  let audio: Blob;
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_VOICE_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify({
        text,
        model_id: DEFAULT_MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.5 },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`ElevenLabs request failed (${response.status})${detail ? `: ${detail}` : ''}`);
    }
    audio = await response.blob();
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }

  await playAudio(audio, volume, signal);
}

export async function speak(text: string, options: SpeakOptions): Promise<void> {
  if (options.signal.aborted) throw abortError();
  if (options.provider === 'elevenlabs') {
    await speakWithElevenLabs(text, options);
  } else {
    await speakWithBrowser(text, options);
  }
}

export function getAvailableBrowserVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  return window.speechSynthesis.getVoices();
}
