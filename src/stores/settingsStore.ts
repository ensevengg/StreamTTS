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

interface SettingsState {
  apiKey: string;
  volume: number;
  ttsProvider: TTSProvider;
  selectedVoice: string;
  setApiKey: (key: string) => void;
  setVolume: (volume: number) => void;
  setTtsProvider: (provider: TTSProvider) => void;
  setSelectedVoice: (voice: string) => void;
}

const defaults = {
  apiKey: '',
  volume: 0.7,
  ttsProvider: 'browser' as TTSProvider,
  selectedVoice: '',
};

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
      merge: (persisted, current) => {
        const parsed = settingsSchema.safeParse(persisted);
        return parsed.success ? { ...current, ...parsed.data } : current;
      },
    }
  )
);
