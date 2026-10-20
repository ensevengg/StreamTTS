import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { z } from 'zod';
import { secureStateStorage } from '@/lib/secureStorage';

export type TTSProvider = 'browser' | 'elevenlabs';

export const TTS_MAX_LENGTH_RANGE = { min: 50, max: 500 } as const;
export const TTS_COOLDOWN_RANGE_SEC = { min: 0, max: 120 } as const;

const settingsSchema = z.object({
  apiKey: z.string(),
  volume: z.number().min(0).max(1),
  ttsProvider: z.enum(['browser', 'elevenlabs']),
  /** Browser voice for `!г` (Russian) messages. */
  selectedVoice: z.string(),
  /** Browser voice for `!r` (English) messages and alerts. */
  englishVoice: z.string(),
  ttsMaxLength: z.number().int().min(TTS_MAX_LENGTH_RANGE.min).max(TTS_MAX_LENGTH_RANGE.max),
  ttsViewerCooldownSec: z.number().int().min(TTS_COOLDOWN_RANGE_SEC.min).max(TTS_COOLDOWN_RANGE_SEC.max),
});

type Settings = z.infer<typeof settingsSchema>;

interface SettingsState extends Settings {
  setApiKey: (key: string) => void;
  setVolume: (volume: number) => void;
  setTtsProvider: (provider: TTSProvider) => void;
  setSelectedVoice: (voice: string) => void;
  setEnglishVoice: (voice: string) => void;
  setTtsMaxLength: (length: number) => void;
  setTtsViewerCooldownSec: (seconds: number) => void;
}

const defaults: Settings = {
  apiKey: '',
  volume: 0.7,
  ttsProvider: 'browser',
  selectedVoice: '',
  englishVoice: '',
  ttsMaxLength: 200,
  ttsViewerCooldownSec: 10,
};

/**
 * Field by field, so settings saved by an older version (or one bad value)
 * don't throw away the rest, the API key included.
 */
export function mergePersistedSettings<T extends Settings>(persisted: unknown, current: T): T {
  const stored = (persisted ?? {}) as Record<string, unknown>;
  const merged: T = { ...current };
  for (const key of Object.keys(settingsSchema.shape) as (keyof Settings)[]) {
    const parsed = settingsSchema.shape[key].safeParse(stored[key]);
    if (parsed.success) (merged as Record<string, unknown>)[key] = parsed.data;
  }
  return merged;
}

// Persisted (including the ElevenLabs API key) via the OS keychain; see
// secureStateStorage. Hydration is async — state holds defaults until it lands.
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...defaults,

      setApiKey: (apiKey) => set({ apiKey }),
      setVolume: (volume) => set({ volume }),
      setTtsProvider: (ttsProvider) => set({ ttsProvider }),
      setSelectedVoice: (selectedVoice) => set({ selectedVoice }),
      setEnglishVoice: (englishVoice) => set({ englishVoice }),
      setTtsMaxLength: (ttsMaxLength) => set({ ttsMaxLength }),
      setTtsViewerCooldownSec: (ttsViewerCooldownSec) => set({ ttsViewerCooldownSec }),
    }),
    {
      name: 'streamtts-settings',
      storage: createJSONStorage(() => secureStateStorage),
      merge: (persisted, current) => mergePersistedSettings(persisted, current),
    }
  )
);
