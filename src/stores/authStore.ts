import { create } from 'zustand';
import { hasTwitchOAuthToken } from '@/services/twitchService';
import { hasYoutubeOAuthToken } from '@/services/youtubeService';

/** A Twitch device-code login waiting for the user to approve it. */
export interface PendingTwitchLogin {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

interface AuthState {
  isTwitchAuthed: boolean;
  isYoutubeAuthed: boolean;
  /** False until the first keychain read completes; routing waits on this. */
  hydrated: boolean;
  twitchLogin: PendingTwitchLogin | null;
  youtubeLoginPending: boolean;
  setTwitchAuth: (authed: boolean) => void;
  setYoutubeAuth: (authed: boolean) => void;
  setTwitchLogin: (login: PendingTwitchLogin | null) => void;
  setYoutubeLoginPending: (pending: boolean) => void;
  hydrate: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  isTwitchAuthed: false,
  isYoutubeAuthed: false,
  hydrated: false,
  twitchLogin: null,
  youtubeLoginPending: false,

  setTwitchAuth: (authed) => set({ isTwitchAuthed: authed }),
  setYoutubeAuth: (authed) => set({ isYoutubeAuthed: authed }),
  setTwitchLogin: (login) => set({ twitchLogin: login }),
  setYoutubeLoginPending: (pending) => set({ youtubeLoginPending: pending }),

  hydrate: async () => {
    const [twitch, youtube] = await Promise.all([
      hasTwitchOAuthToken().catch(() => false),
      hasYoutubeOAuthToken().catch(() => false),
    ]);
    set({ isTwitchAuthed: twitch, isYoutubeAuthed: youtube, hydrated: true });
  },
}));
