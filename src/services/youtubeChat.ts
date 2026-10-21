import { backoffDelay, BoundedSet } from '@/lib/resilience';
import {
  fetchActiveBroadcasts,
  fetchLiveChatPage,
  getValidYoutubeToken,
  invalidateYoutubeAccessToken,
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
  onStatus: (status: YouTubeChatStatus, detail?: string) => void;
  onBroadcast: (title: string) => void;
}

export interface YouTubeChatDeps {
  getToken: () => Promise<TokenResult>;
  invalidateToken: () => Promise<void>;
  fetchBroadcasts: (token: string, signal: AbortSignal) => Promise<LiveBroadcast[]>;
  fetchPage: (token: string, liveChatId: string, pageToken: string | null, signal: AbortSignal) => Promise<LiveChatPage>;
  now: () => number;
}

const defaultDeps: YouTubeChatDeps = {
  getToken: getValidYoutubeToken,
  invalidateToken: invalidateYoutubeAccessToken,
  fetchBroadcasts: fetchActiveBroadcasts,
  fetchPage: fetchLiveChatPage,
  now: Date.now,
};

/**
 * Polling floor. Every poll costs 5 units of the Google project's daily quota
 * (10,000 by default, shared by everyone using this client ID), so we never
 * poll faster than this even when YouTube suggests a shorter interval.
 */
export const MIN_POLL_MS = 5000;
/** How often to look for a broadcast while waiting (1 quota unit per check). */
export const BROADCAST_CHECK_MS = 30_000;
/** Messages this much older than the moment a chat ended still get read. */
const RESUME_SLACK_MS = 60_000;
const MAX_AUTH_FAILURES = 2;

class SignedOutError extends Error {}
class TokenUnavailableError extends Error {}

type ErrorKind =
  | { kind: 'transient'; detail: string }
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

type Task = 'discover' | 'poll';

interface AttachedChat {
  liveChatId: string;
  pageToken: string | null;
  /** Read first-page messages published after this; null skips the backlog. */
  since: number | null;
}

/**
 * The signed-in channel's live chat. It finds the active broadcast (or waits
 * for one), polls its chat, rides out network trouble with backoff, and when
 * a stream crashes and its chat ends it attaches to the next broadcast on its
 * own.
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
    try {
      if (task === 'discover') await this.discover(controller.signal);
      else await this.poll(controller.signal);
    } catch (error) {
      if (!this.stopped) await this.handleError(task, error);
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
      // After a crash, read what viewers sent while we were away.
      since: this.endedAt === null ? null : this.endedAt - RESUME_SLACK_MS,
    };
    this.handlers.onBroadcast(live.snippet.title || 'YouTube live stream');
    this.schedule('poll', 0);
  }

  private async poll(signal: AbortSignal): Promise<void> {
    const chat = this.chat;
    if (!chat) {
      this.schedule('discover', 0);
      return;
    }
    const page = await this.deps.fetchPage(await this.token(), chat.liveChatId, chat.pageToken, signal);
    if (this.stopped || chat !== this.chat) return;

    this.failures = 0;
    this.authFailures = 0;
    this.setStatus('connected');

    const firstPage = chat.pageToken === null;
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

    if (ended) {
      this.chatEnded(chat, 'The stream ended. Waiting for it to go live again.');
      return;
    }
    this.schedule('poll', Math.max(page.pollingIntervalMillis ?? MIN_POLL_MS, MIN_POLL_MS));
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
    }
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
      case 'chat_ended':
        if (task === 'poll' && this.chat) {
          this.chatEnded(this.chat, classified.detail);
        } else {
          this.setStatus('waiting', classified.detail);
          this.schedule('discover', BROADCAST_CHECK_MS);
        }
        return;
      case 'reset_page':
        if (this.chat) {
          this.chat.pageToken = null;
          this.chat.since = this.deps.now() - RESUME_SLACK_MS;
        }
        this.schedule(task, 0);
        return;
      case 'fatal':
        this.fail(classified.message);
        return;
      case 'transient': {
        this.failures += 1;
        const delay = backoffDelay(this.failures, { baseMs: 5000, maxMs: 60_000 });
        this.setStatus('reconnecting', `${classified.detail}. Retrying in ${Math.ceil(delay / 1000)}s.`);
        this.schedule(task, delay);
      }
    }
  }

  private fail(message: string): void {
    this.stopped = true;
    this.clearTimer();
    this.setStatus('error', message);
  }
}
