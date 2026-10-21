import { toast } from '@/hooks/use-toast';
import { TTS_COMMAND_PREFIX } from '@/config/constants';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import { cancelTwitchLogin } from '@/services/authService';
import { ttsQueueService } from '@/services/ttsQueueService';
import {
  clearTwitchOAuthToken,
  connectToTwitchChat,
  disconnectFromTwitchChat,
  getTwitchIdentity,
} from '@/services/twitchService';
import {
  clearYoutubeOAuthToken,
  connectToYouTubeLiveChat,
  fetchYouTubeLiveBroadcasts,
} from '@/services/youtubeService';
import type { ChatPlatform } from '@/types/chatSource';
import type { Message } from '@/types/message';

/*
 * Chat sessions live here, at module level, rather than in a component, so
 * switching tabs (which unmounts the Connections tab) can neither leak a
 * session nor lose the handle needed to stop it.
 */

// Bumped whenever a session is replaced or stopped, so late callbacks from
// the old one are ignored.
let twitchGeneration = 0;
let youtubeGeneration = 0;
let youtubeDisconnect: (() => void) | null = null;

function receiveChatMessage(platform: ChatPlatform, id: string, username: string, text: string, timestamp = Date.now()): void {
  const message: Message = { id: `${platform}-${id}`, content: text, timestamp, username, status: 'pending' };
  useChatStore.getState().addMessage(message);
  if (text.startsWith(TTS_COMMAND_PREFIX)) ttsQueueService.enqueue(message);
}

const randomId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
  const username = session.identity.login;

  stopTwitch();
  const generation = twitchGeneration;
  useChatStore.getState().upsertConnection({
    id: 'twitch',
    type: 'twitch',
    channelName: username,
    status: 'connecting',
  });

  await connectToTwitchChat(
    username,
    (twitchUser, text) => {
      if (generation === twitchGeneration) receiveChatMessage('twitch', randomId(), twitchUser, text);
    },
    (connected, error) => {
      if (generation !== twitchGeneration) return;
      useChatStore.getState().updateConnection('twitch', {
        status: connected ? 'connected' : 'error',
        detail: connected ? undefined : error,
      });
      if (connected) {
        toast({ title: 'Connected to Twitch', description: `Now listening to ${username}'s chat` });
      } else if (error && !error.includes('RECONNECT')) {
        toast({ title: 'Twitch chat stopped', description: error, variant: 'destructive' });
      }
    },
  );
}

function stopTwitch(): void {
  twitchGeneration += 1;
  disconnectFromTwitchChat().catch(error => console.error('Error disconnecting from Twitch:', error));
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

interface LiveBroadcast {
  id: string;
  snippet?: { title?: string };
}

interface LiveChatItem {
  id?: string;
  snippet?: { displayMessage?: string; publishedAt?: string };
  authorDetails?: { displayName?: string };
}

export async function connectYoutube(): Promise<void> {
  const broadcasts = (await fetchYouTubeLiveBroadcasts()) as LiveBroadcast[];
  const broadcast = broadcasts[0];
  if (!broadcast) throw new Error('No live stream found. Start a live stream on YouTube, then try again.');

  stopYoutube();
  const generation = youtubeGeneration;
  const title = broadcast.snippet?.title || broadcast.id;
  useChatStore.getState().upsertConnection({
    id: 'youtube',
    type: 'youtube',
    channelName: title,
    status: 'connecting',
  });

  // Setup failures are reported by the rejection below; only errors from a
  // running poller go through onError.
  let attached = false;
  try {
    const { disconnect } = await connectToYouTubeLiveChat(
      broadcast.id,
      (item: LiveChatItem) => {
        if (generation !== youtubeGeneration) return;
        const published = item.snippet?.publishedAt ? new Date(item.snippet.publishedAt).getTime() : Date.now();
        receiveChatMessage(
          'youtube',
          item.id || randomId(),
          item.authorDetails?.displayName || 'Anonymous',
          item.snippet?.displayMessage || '',
          published,
        );
      },
      (error) => {
        if (!attached || generation !== youtubeGeneration) return;
        useChatStore.getState().updateConnection('youtube', { status: 'error', detail: error.message });
        toast({ title: 'YouTube chat stopped', description: error.message, variant: 'destructive' });
      },
    );
    if (generation !== youtubeGeneration) {
      disconnect();
      return;
    }
    attached = true;
    youtubeDisconnect = disconnect;
    useChatStore.getState().updateConnection('youtube', { status: 'connected' });
    toast({ title: 'Connected to YouTube', description: `Now listening to live chat for: ${title}` });
  } catch (error) {
    if (generation === youtubeGeneration) useChatStore.getState().removeConnection('youtube');
    throw error;
  }
}

function stopYoutube(): void {
  youtubeGeneration += 1;
  youtubeDisconnect?.();
  youtubeDisconnect = null;
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
