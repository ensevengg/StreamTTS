import { toast } from '@/hooks/use-toast';
import { TTS_COMMAND_PREFIX } from '@/config/constants';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import { AlertService } from '@/services/alertsService';
import { cancelTwitchLogin } from '@/services/authService';
import { speakChatMessage } from '@/services/chatSpeech';
import { TwitchChatSession } from '@/services/twitchChat';
import { TwitchEventSubSession } from '@/services/twitchEventSub';
import {
  clearTwitchOAuthToken,
  getTwitchIdentity,
  TWITCH_ALERT_SCOPES,
  type TwitchIdentity,
} from '@/services/twitchService';
import { YouTubeChatSession } from '@/services/youtubeChat';
import { clearYoutubeOAuthToken, hasYoutubeOAuthToken } from '@/services/youtubeService';
import type { ChatPlatform } from '@/types/chatSource';

/*
 * Chat sessions live here, at module level, rather than in a component, so
 * switching tabs (which unmounts the Connections tab) can neither leak a
 * session nor lose the handle needed to stop it.
 */

interface TwitchSessions {
  identity: TwitchIdentity;
  chat: TwitchChatSession;
  events: TwitchEventSubSession | null;
}

let twitch: TwitchSessions | null = null;
let youtube: YouTubeChatSession | null = null;

function receiveChatMessage(platform: ChatPlatform, id: string, username: string, text: string): void {
  const message = { id: `${platform}-${id}`, content: text, timestamp: Date.now(), username };
  useChatStore.getState().addMessage(message);
  if (text.startsWith(TTS_COMMAND_PREFIX)) speakChatMessage(message, { fromViewer: true });
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

  stopTwitch();
  const { identity } = session;
  useChatStore.getState().upsertConnection({
    id: 'twitch',
    type: 'twitch',
    channelName: identity.login,
    status: 'connecting',
  });

  const notify = statusNotifier('Twitch');
  const chat = new TwitchChatSession(identity.login, {
    onMessage: (m) => receiveChatMessage('twitch', m.id, m.username, m.text),
    onStatus: (status, detail) => {
      if (twitch?.chat !== chat) return;
      useChatStore.getState().updateConnection('twitch', { status, detail });
      notify(status, detail);
      if (status === 'error') {
        twitch.events?.stop();
        twitch.events = null;
        if (/log in again/i.test(detail ?? '')) void markTwitchSignedOut();
      }
    },
  });
  twitch = { identity, chat, events: null };
  chat.start();
  syncTwitchAlerts();
}

/** Opens or closes the EventSub connection to match the alert settings. */
function syncTwitchAlerts(): void {
  if (!twitch) return;
  const sessions = twitch;
  const wanted = AlertService.getInstance().wantsTwitchEvents();

  if (!wanted) {
    sessions.events?.stop();
    sessions.events = null;
    useChatStore.getState().updateConnection('twitch', { alertsDetail: undefined });
    return;
  }
  if (sessions.events) return;

  const missing = TWITCH_ALERT_SCOPES.filter(scope => !sessions.identity.scopes.includes(scope));
  if (missing.length > 0) {
    useChatStore.getState().updateConnection('twitch', {
      alertsDetail: 'Alerts are off: log out and log in again to allow them.',
    });
    return;
  }

  const events = new TwitchEventSubSession(sessions.identity.userId, sessions.identity.clientId, {
    onAlert: (alert) => AlertService.getInstance().publish(alert),
    onStatus: (status, detail) => {
      if (twitch?.events !== events) return;
      const alertsDetail = status === 'connected' ? detail : detail ?? 'Alerts unavailable';
      useChatStore.getState().updateConnection('twitch', { alertsDetail });
    },
  });
  sessions.events = events;
  events.start();
}

function stopTwitch(): void {
  twitch?.chat.stop();
  twitch?.events?.stop();
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
    onAlert: (alert) => AlertService.getInstance().publish(alert),
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

AlertService.getInstance().onSettingsChange(syncTwitchAlerts);

if (typeof window !== 'undefined') {
  // Don't sit out the rest of a backoff wait once the network is back.
  window.addEventListener?.('online', () => {
    twitch?.chat.retryNow();
    twitch?.events?.retryNow();
    youtube?.retryNow();
  });
}
