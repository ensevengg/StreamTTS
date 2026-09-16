import { create } from 'zustand';
import { hasTwitchOAuthToken } from '@/services/twitchService';
import { hasYoutubeOAuthToken } from '@/services/youtubeService';

interface AuthState {
  isTwitchAuthed: boolean;
  isYoutubeAuthed: boolean;
  /** False until the first keychain read completes; routing waits on this. */
  hydrated: boolean;
  setTwitchAuth: (authed: boolean) => void;
  setYoutubeAuth: (authed: boolean) => void;
  hydrate: () => Promise<void>;
  logoutTwitch: () => void;
  logoutYoutube: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isTwitchAuthed: false,
  isYoutubeAuthed: false,
  hydrated: false,

  setTwitchAuth: (authed) => set({ isTwitchAuthed: authed }),
  setYoutubeAuth: (authed) => set({ isYoutubeAuthed: authed }),

  hydrate: async () => {
    const [twitch, youtube] = await Promise.all([
      hasTwitchOAuthToken().catch(() => false),
      hasYoutubeOAuthToken().catch(() => false),
    ]);
    set({ isTwitchAuthed: twitch, isYoutubeAuthed: youtube, hydrated: true });
  },

  logoutTwitch: () => set({ isTwitchAuthed: false }),
  logoutYoutube: () => set({ isYoutubeAuthed: false }),
}));
