import { toast } from '@/hooks/use-toast';
import { TTS_COMMAND_PREFIX } from '@/config/constants';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import { cancelTwitchLogin } from '@/services/authService';
import { speakChatMessage } from '@/services/chatSpeech';
import { TwitchChatSession } from '@/services/twitchChat';
import { clearTwitchOAuthToken, getTwitchIdentity } from '@/services/twitchService';
import { YouTubeChatSession } from '@/services/youtubeChat';
import { clearYoutubeOAuthToken, hasYoutubeOAuthToken } from '@/services/youtubeService';
import type { ChatPlatform } from '@/types/chatSource';

/*
 * Chat sessions live here, at module level, rather than in a component, so
 * switching tabs (which unmounts the Connections tab) can neither leak a
 * session nor lose the handle needed to stop it.
 */

let twitch: TwitchChatSession | null = null;
let youtube: YouTubeChatSession | null = null;

function receiveChatMessage(platform: ChatPlatform, id: string, username: string, text: string): void {
  const message = { id: `${platform}-${id}`, content: text, timestamp: Date.now(), username };
  useChatStore.getState().addMessage(message);
  if (text.startsWith(TTS_COMMAND_PREFIX)) speakChatMessage(message);
}

/** Toasts on the transitions that matter, not on every retry. */
function statusNotifier(label: string) {
  let wasConnected = false;
  return (status: string, detail?: string) => {
    if (status === 'connected') {
      toast({ title: wasConnected ? `${label} chat reconnected` : `Connected to ${label}` });
      wasConnected = true;
    } else if (status === 'error') {
      toast({ title: `${label} chat stopped`, description: detail, variant: 'destructive' });
    }
  };
}

// ---- Twitch ---------------------------------------------------------------

export async function connectTwitch(): Promise<void> {
  const session = await getTwitchIdentity();
  if (session.status === 'signed_out') {
    await signOutTwitch();
    throw new Error('Your Twitch session expired. Log in again.');
  }
  if (session.status === 'unreachable') {
    throw new Error("Couldn't reach Twitch. Check your internet connection and try again.");
  }
  const { login } = session.identity;

  stopTwitch();
  useChatStore.getState().upsertConnection({
    id: 'twitch',
    type: 'twitch',
    channelName: login,
    status: 'connecting',
  });

  const notify = statusNotifier('Twitch');
  const chat = new TwitchChatSession(login, {
    onMessage: (m) => receiveChatMessage('twitch', m.id, m.username, m.text),
    onStatus: (status, detail) => {
      if (twitch !== chat) return;
      useChatStore.getState().updateConnection('twitch', { status, detail });
      notify(status, detail);
      if (status === 'error' && /log in again/i.test(detail ?? '')) void markTwitchSignedOut();
    },
  });
  twitch = chat;
  chat.start();
}

function stopTwitch(): void {
  twitch?.stop();
  twitch = null;
}

export function disconnectTwitch(): void {
  stopTwitch();
  useChatStore.getState().removeConnection('twitch');
}

async function markTwitchSignedOut(): Promise<void> {
  await clearTwitchOAuthToken();
  useAuthStore.getState().setTwitchAuth(false);
}

export async function signOutTwitch(): Promise<void> {
  disconnectTwitch();
  useAuthStore.getState().setTwitchLogin(null);
  await cancelTwitchLogin().catch(() => {});
  await markTwitchSignedOut();
}

// ---- YouTube --------------------------------------------------------------

export function connectYoutube(): void {
  stopYoutube();
  useChatStore.getState().upsertConnection({
    id: 'youtube',
    type: 'youtube',
    channelName: 'YouTube live chat',
    status: 'connecting',
  });

  const notify = statusNotifier('YouTube');
  const session = new YouTubeChatSession({
    onMessage: (m) => receiveChatMessage('youtube', m.id, m.username, m.text),
    onBroadcast: (title) => {
      if (youtube === session) useChatStore.getState().updateConnection('youtube', { channelName: title });
    },
    onStatus: (status, detail) => {
      if (youtube !== session) return;
      useChatStore.getState().updateConnection('youtube', { status, detail });
      notify(status, detail);
      if (status === 'error') {
        // A rejected refresh token clears the stored login; reflect that.
        void hasYoutubeOAuthToken().then(authed => {
          if (!authed) useAuthStore.getState().setYoutubeAuth(false);
        });
      }
    },
  });
  youtube = session;
  session.start();
}

function stopYoutube(): void {
  youtube?.stop();
  youtube = null;
}

export function disconnectYoutube(): void {
  stopYoutube();
  useChatStore.getState().removeConnection('youtube');
}

export async function signOutYoutube(): Promise<void> {
  disconnectYoutube();
  useAuthStore.getState().setYoutubeLoginPending(false);
  await clearYoutubeOAuthToken();
  useAuthStore.getState().setYoutubeAuth(false);
}

// ---- Wiring ---------------------------------------------------------------

if (typeof window !== 'undefined') {
  // Don't sit out the rest of a backoff wait once the network is back.
  window.addEventListener?.('online', () => {
    twitch?.retryNow();
    youtube?.retryNow();
  });
}
