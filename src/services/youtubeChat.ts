import { backoffDelay, BoundedSet } from '@/lib/resilience';
import type { AlertData } from '@/services/alertsService';
import {
  fetchActiveBroadcasts,
  fetchLiveChatPage,
  getValidYoutubeToken,
  invalidateYoutubeAccessToken,
  streamLiveChat,
  StreamTransportError,
  StreamUnavailableError,
  YouTubeApiError,
  type LiveBroadcast,
  type LiveChatItem,
  type LiveChatPage,
  type TokenResult,
} from '@/services/youtubeService';

export type YouTubeChatStatus = 'connecting' | 'connected' | 'reconnecting' | 'waiting' | 'error';

export interface YouTubeChatMessage {
  id: string;
  username: string;
  text: string;
}

export interface YouTubeChatHandlers {
  onMessage: (message: YouTubeChatMessage) => void;
  onAlert: (alert: AlertData) => void;
  onStatus: (status: YouTubeChatStatus, detail?: string) => void;
  onBroadcast: (title: string) => void;
}

export interface YouTubeChatDeps {
  getToken: () => Promise<TokenResult>;
  invalidateToken: () => Promise<void>;
  fetchBroadcasts: (token: string, signal: AbortSignal) => Promise<LiveBroadcast[]>;
  fetchPage: (token: string, liveChatId: string, pageToken: string | null, signal: AbortSignal) => Promise<LiveChatPage>;
  openStream: (
    token: string,
    liveChatId: string,
    pageToken: string | null,
    onPage: (page: LiveChatPage) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  now: () => number;
}

const defaultDeps: YouTubeChatDeps = {
  getToken: getValidYoutubeToken,
  invalidateToken: invalidateYoutubeAccessToken,
  fetchBroadcasts: fetchActiveBroadcasts,
  fetchPage: fetchLiveChatPage,
  openStream: streamLiveChat,
  now: Date.now,
};

/**
 * Polling floor, and the shortest gap between opening chat streams. Every
 * poll, and every new stream, costs 5 units of the Google project's daily
 * quota (10,000 by default, shared by everyone using this client ID).
 * Streaming is the normal path; polling is the fallback when it can't work.
 */
export const MIN_POLL_MS = 5000;
/** Consecutive failures to reach the gRPC endpoint before falling back to polling. */
const MAX_STREAM_TRANSPORT_FAILURES = 3;
/**
 * After falling back to polling, try streaming again after this long (the
 * failures may just have been an outage, and polling costs far more quota),
 * doubling after each failed retry up to STREAM_RETRY_MAX_MS.
 */
export const STREAM_RETRY_MS = 10 * 60_000;
const STREAM_RETRY_MAX_MS = 2 * 60 * 60_000;
/** How often to look for a broadcast while waiting (1 quota unit per check). */
export const BROADCAST_CHECK_MS = 30_000;
/** Messages this much older than the moment a chat ended still get read. */
const RESUME_SLACK_MS = 60_000;
const MAX_AUTH_FAILURES = 2;

class SignedOutError extends Error {}
class TokenUnavailableError extends Error {}

type ErrorKind =
  | { kind: 'transient'; detail: string; transport?: boolean }
  | { kind: 'stream_unavailable' }
  | { kind: 'auth' }
  | { kind: 'chat_ended'; detail: string }
  | { kind: 'reset_page' }
  | { kind: 'fatal'; message: string };

export function classifyYouTubeError(error: unknown): ErrorKind {
  if (error instanceof SignedOutError) {
    return { kind: 'fatal', message: 'Your YouTube session expired. Log in again.' };
  }
  if (error instanceof TokenUnavailableError) {
    return { kind: 'transient', detail: 'Could not refresh the YouTube login' };
  }
  if (error instanceof StreamUnavailableError) return { kind: 'stream_unavailable' };
  if (error instanceof StreamTransportError) {
    return { kind: 'transient', detail: 'Connection to YouTube lost', transport: true };
  }
  if (!(error instanceof YouTubeApiError)) {
    // fetch rejects on network failures and timeouts.
    return { kind: 'transient', detail: 'Connection to YouTube lost' };
  }

  const { status, reason } = error;
  if (status === 401) return { kind: 'auth' };
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return {
      kind: 'fatal',
      message: "YouTube's daily API quota for StreamTTS is used up. Chat works again after it resets at midnight Pacific time.",
    };
  }
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || status === 429 || status >= 500) {
    return { kind: 'transient', detail: 'YouTube is busy' };
  }
  if (reason === 'liveChatEnded' || reason === 'liveChatNotFound' || status === 404) {
    return { kind: 'chat_ended', detail: 'The stream ended. Waiting for it to go live again.' };
  }
  if (reason === 'liveChatDisabled') {
    return { kind: 'chat_ended', detail: 'Live chat is turned off for this stream. Waiting for a stream with chat.' };
  }
  if (reason === 'pageTokenInvalid' || reason === 'invalidPageToken') return { kind: 'reset_page' };
  if (status === 403) {
    return { kind: 'fatal', message: 'YouTube denied access to this chat. Log out and log in again.' };
  }
  return { kind: 'fatal', message: `YouTube rejected the request: ${error.message}` };
}

const limit = (text: string | undefined, max: number): string => (text ?? '').trim().slice(0, max);

/** Super Chats, stickers and memberships arrive in the chat feed itself. */
export function chatItemToAlert(item: LiveChatItem): AlertData | null {
  const snippet = item.snippet;
  const user = limit(item.authorDetails?.displayName, 50) || 'Someone';
  switch (snippet?.type) {
    case 'superChatEvent':
      return {
        platform: 'youtube',
        alert_type: 'superchat',
        user_name: user,
        message: `${user} sent a ${limit(snippet.superChatDetails?.amountDisplayString, 20)} Super Chat!`,
        detail: limit(snippet.superChatDetails?.userComment, 200) || undefined,
      };
    case 'superStickerEvent':
      return {
        platform: 'youtube',
        alert_type: 'superchat',
        user_name: user,
        message: `${user} sent a ${limit(snippet.superStickerDetails?.amountDisplayString, 20)} Super Sticker!`,
      };
    case 'newSponsorEvent': {
      const level = limit(snippet.newSponsorDetails?.memberLevelName, 50);
      return {
        platform: 'youtube',
        alert_type: 'member',
        user_name: user,
        message: snippet.newSponsorDetails?.isUpgrade && level
          ? `${user} upgraded to ${level}!`
          : `${user} just became a member!`,
      };
    }
    case 'membershipGiftingEvent': {
      const count = snippet.membershipGiftingDetails?.giftMembershipsCount ?? 1;
      return {
        platform: 'youtube',
        alert_type: 'member',
        user_name: user,
        message: `${user} gifted ${count} membership${count === 1 ? '' : 's'}!`,
        count,
      };
    }
    case 'memberMilestoneChatEvent': {
      const months = snippet.memberMilestoneChatDetails?.memberMonth;
      return {
        platform: 'youtube',
        alert_type: 'member',
        user_name: user,
        message: months ? `${user} has been a member for ${months} months!` : `${user} hit a membership milestone!`,
        detail: limit(snippet.memberMilestoneChatDetails?.userComment, 200) || undefined,
      };
    }
    default:
      return null;
  }
}

type Task = 'discover' | 'listen' | 'poll';

interface AttachedChat {
  liveChatId: string;
  pageToken: string | null;
  /** Set once the first page (with its backlog) has been handled. */
  primed: boolean;
  /** Read first-page messages published after this; null skips the backlog. */
  since: number | null;
}

/**
 * The signed-in channel's live chat. It finds the active broadcast (or waits
 * for one), streams its chat (polling if streaming can't work), rides out
 * network trouble with backoff, and when a stream crashes and its chat ends
 * it attaches to the next broadcast on its own.
 */
export class YouTubeChatSession {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingTask: Task | null = null;
  private controller: AbortController | null = null;
  private chat: AttachedChat | null = null;
  private readonly endedChatIds = new Set<string>();
  private endedAt: number | null = null;
  private failures = 0;
  private authFailures = 0;
  private lastStatus: string | null = null;
  private readonly seen = new BoundedSet<string>(5000);
  private streaming = true;
  private streamTransportFailures = 0;
  /** When polling, the time to try streaming again (Infinity: never). */
  private streamRetryAt = 0;
  private streamRetryDelay = STREAM_RETRY_MS;
  /** Retrying streaming after a fallback: one failure goes straight back. */
  private streamProbation = false;

  constructor(
    private readonly handlers: YouTubeChatHandlers,
    private readonly deps: YouTubeChatDeps = defaultDeps,
  ) {}

  start(): void {
    this.setStatus('connecting');
    this.schedule('discover', 0);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.controller?.abort();
  }

  /** Skips a pending backoff wait, e.g. when the network comes back. */
  retryNow(): void {
    if (this.stopped || this.failures === 0 || !this.pendingTask) return;
    this.schedule(this.pendingTask, 0);
  }

  private setStatus(status: YouTubeChatStatus, detail?: string): void {
    const key = `${status}:${detail ?? ''}`;
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.handlers.onStatus(status, detail);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingTask = null;
  }

  private schedule(task: Task, delayMs: number): void {
    if (this.stopped) return;
    this.clearTimer();
    this.pendingTask = task;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pendingTask = null;
      void this.run(task);
    }, delayMs);
  }

  private async run(task: Task): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.controller = controller;
    const chat = this.chat;
    try {
      if (task === 'discover') await this.discover(controller.signal);
      else if (task === 'listen') await this.listen(controller.signal);
      else await this.poll(controller.signal);
    } catch (error) {
      // A stream can fail after its chat has already ended and the session
      // moved on; that error belongs to a chat we no longer read.
      const stale = task !== 'discover' && chat !== this.chat;
      if (!this.stopped && !stale) await this.handleError(task, error);
    }
  }

  private async token(): Promise<string> {
    const result = await this.deps.getToken();
    if (result.status === 'signed_out') throw new SignedOutError();
    if (result.status === 'unavailable') throw new TokenUnavailableError(result.reason);
    return result.token;
  }

  private async discover(signal: AbortSignal): Promise<void> {
    const broadcasts = await this.deps.fetchBroadcasts(await this.token(), signal);
    if (this.stopped) return;
    this.failures = 0;

    const live = broadcasts.find(
      (b) => b.snippet?.liveChatId && !this.endedChatIds.has(b.snippet.liveChatId),
    );
    if (!live?.snippet?.liveChatId) {
      this.setStatus(
        'waiting',
        this.endedAt ? 'The stream ended. Waiting for it to go live again.' : 'Waiting for your YouTube stream to go live.',
      );
      this.schedule('discover', BROADCAST_CHECK_MS);
      return;
    }

    this.chat = {
      liveChatId: live.snippet.liveChatId,
      pageToken: null,
      primed: false,
      // After a crash, read what viewers sent while we were away.
      since: this.endedAt === null ? null : this.endedAt - RESUME_SLACK_MS,
    };
    this.handlers.onBroadcast(live.snippet.title || 'YouTube live stream');
    this.schedule(this.readTask(), 0);
  }

  private readTask(): Task {
    return this.streaming ? 'listen' : 'poll';
  }

  private async listen(signal: AbortSignal): Promise<void> {
    const chat = this.chat;
    if (!chat) {
      this.schedule('discover', 0);
      return;
    }
    const token = await this.token();
    const openedAt = this.deps.now();
    let ended = false;
    await this.deps.openStream(token, chat.liveChatId, chat.pageToken, (page) => {
      if (this.stopped || chat !== this.chat || ended) return;
      this.streamTransportFailures = 0;
      this.streamProbation = false;
      this.streamRetryDelay = STREAM_RETRY_MS;
      ended = this.handlePage(chat, page);
    }, signal);
    if (this.stopped || chat !== this.chat || ended) return;

    // YouTube closed the stream; reopen from the last page token. A new
    // stream costs as much quota as a poll, so never reopen faster than
    // polling would run.
    this.schedule('listen', Math.max(0, MIN_POLL_MS - (this.deps.now() - openedAt)));
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const chat = this.chat;
    if (!chat) {
      this.schedule('discover', 0);
      return;
    }
    const page = await this.deps.fetchPage(await this.token(), chat.liveChatId, chat.pageToken, signal);
    if (this.stopped || chat !== this.chat) return;
    if (this.handlePage(chat, page)) return;
    if (this.deps.now() >= this.streamRetryAt) {
      this.streaming = true;
      this.streamProbation = true;
      this.streamTransportFailures = 0;
      this.schedule('listen', 0);
      return;
    }
    this.schedule('poll', Math.max(page.pollingIntervalMillis ?? MIN_POLL_MS, MIN_POLL_MS));
  }

  /** Handles one page, polled or streamed. Returns true if the chat ended. */
  private handlePage(chat: AttachedChat, page: LiveChatPage): boolean {
    this.failures = 0;
    this.authFailures = 0;
    this.setStatus('connected');

    const firstPage = !chat.primed;
    chat.primed = true;
    chat.pageToken = page.nextPageToken ?? chat.pageToken;
    let ended = false;
    for (const item of page.items ?? []) {
      if (!this.seen.add(item.id)) continue;
      if (item.snippet?.type === 'chatEndedEvent') {
        ended = true;
        continue;
      }
      if (firstPage && !this.isAfter(item, chat.since)) continue;
      this.dispatch(item);
    }

    if (ended) this.chatEnded(chat, 'The stream ended. Waiting for it to go live again.');
    return ended;
  }

  private isAfter(item: LiveChatItem, since: number | null): boolean {
    if (since === null) return false;
    const published = Date.parse(item.snippet?.publishedAt ?? '');
    return Number.isNaN(published) || published >= since;
  }

  private dispatch(item: LiveChatItem): void {
    if (item.snippet?.type === 'textMessageEvent') {
      this.handlers.onMessage({
        id: item.id,
        username: item.authorDetails?.displayName || 'Anonymous',
        text: item.snippet.displayMessage ?? '',
      });
      return;
    }
    const alert = chatItemToAlert(item);
    if (alert) this.handlers.onAlert(alert);
  }

  private chatEnded(chat: AttachedChat, detail: string): void {
    this.endedChatIds.add(chat.liveChatId);
    this.endedAt = this.deps.now();
    this.chat = null;
    this.setStatus('waiting', detail);
    this.schedule('discover', BROADCAST_CHECK_MS);
  }

  private async handleError(task: Task, error: unknown): Promise<void> {
    const classified = classifyYouTubeError(error);
    switch (classified.kind) {
      case 'auth':
        this.authFailures += 1;
        if (this.authFailures > MAX_AUTH_FAILURES) {
          this.fail('YouTube keeps rejecting the login. Log out and log in again.');
          return;
        }
        // The token was revoked or expired early; force a refresh and retry.
        await this.deps.invalidateToken();
        this.schedule(task, 1000);
        return;
      case 'stream_unavailable':
        this.fallBackToPolling('YouTube streaming is unavailable', Infinity);
        return;
      case 'chat_ended':
        if (task !== 'discover' && this.chat) {
          this.chatEnded(this.chat, classified.detail);
        } else {
          this.setStatus('waiting', classified.detail);
          this.schedule('discover', BROADCAST_CHECK_MS);
        }
        return;
      case 'reset_page':
        if (this.chat) {
          this.chat.pageToken = null;
          this.chat.primed = false;
          this.chat.since = this.deps.now() - RESUME_SLACK_MS;
        }
        this.schedule(task, 0);
        return;
      case 'fatal':
        this.fail(classified.message);
        return;
      case 'transient': {
        if (task === 'listen' && classified.transport) {
          this.streamTransportFailures += 1;
          // gRPC may be blocked (proxy, firewall) where plain HTTPS works.
          // A retry after a fallback gets one chance, so a blocked network
          // doesn't lose chat while it backs off.
          const limit = this.streamProbation ? 1 : MAX_STREAM_TRANSPORT_FAILURES;
          if (this.streamTransportFailures >= limit) {
            if (this.streamProbation) {
              this.streamRetryDelay = Math.min(this.streamRetryDelay * 2, STREAM_RETRY_MAX_MS);
            }
            this.fallBackToPolling('YouTube streaming is unreachable', this.streamRetryDelay);
            return;
          }
        }
        this.failures += 1;
        const delay = backoffDelay(this.failures, { baseMs: 5000, maxMs: 60_000 });
        this.setStatus('reconnecting', `${classified.detail}. Retrying in ${Math.ceil(delay / 1000)}s.`);
        this.schedule(task, delay);
      }
    }
  }

  /** Polling uses more quota but works over plain HTTPS. */
  private fallBackToPolling(reason: string, retryStreamingAfterMs: number): void {
    console.warn(`${reason}; polling YouTube chat instead.`);
    this.streaming = false;
    this.streamProbation = false;
    this.streamRetryAt = this.deps.now() + retryStreamingAfterMs;
    this.schedule(this.chat ? 'poll' : 'discover', 0);
  }

  private fail(message: string): void {
    this.stopped = true;
    this.clearTimer();
    this.setStatus('error', message);
  }
}
