import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { z } from 'zod';
import { secureStateStorage } from '@/lib/secureStorage';

export type TTSProvider = 'browser' | 'elevenlabs';

const settingsSchema = z.object({
  apiKey: z.string(),
  volume: z.number().min(0).max(1),
  ttsProvider: z.enum(['browser', 'elevenlabs']),
  selectedVoice: z.string(),
});

type Settings = z.infer<typeof settingsSchema>;

interface SettingsState extends Settings {
  setApiKey: (key: string) => void;
  setVolume: (volume: number) => void;
  setTtsProvider: (provider: TTSProvider) => void;
  setSelectedVoice: (voice: string) => void;
}

const defaults: Settings = {
  apiKey: '',
  volume: 0.7,
  ttsProvider: 'browser',
  selectedVoice: '',
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
    }),
    {
      name: 'streamtts-settings',
      storage: createJSONStorage(() => secureStateStorage),
      merge: (persisted, current) => mergePersistedSettings(persisted, current),
    }
  )
);
