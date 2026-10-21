import { backoffDelay, BoundedSet } from '@/lib/resilience';
import { fetchJson, type JsonResponse } from '@/lib/http';
import type { AlertData } from '@/services/alertsService';
import { getValidTwitchToken, refreshTwitchToken, type TokenResult } from '@/services/twitchService';

/**
 * Twitch alerts over EventSub's WebSocket transport. Unlike webhooks it needs
 * no public HTTPS endpoint and no app access token (which would need the
 * client secret): the app connects out with the user's own token.
 */
const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';
const SUBSCRIPTIONS_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';

const ALERT_SUBSCRIPTIONS = [
  { type: 'channel.subscribe', version: '1', label: 'subscriptions' },
  { type: 'channel.subscription.gift', version: '1', label: 'gifted subs' },
  { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', label: 'channel points' },
] as const;

export type EventSubStatus = 'connected' | 'reconnecting' | 'error';

export interface EventSubHandlers {
  onAlert: (alert: AlertData) => void;
  onStatus: (status: EventSubStatus, detail?: string) => void;
}

/** The parts of a browser WebSocket the session uses (mockable in tests). */
export interface SocketLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(code?: number): void;
}

export interface EventSubDeps {
  createSocket: (url: string) => SocketLike;
  getToken: () => Promise<TokenResult>;
  refreshToken: () => Promise<TokenResult>;
  post: (url: string, init: RequestInit) => Promise<JsonResponse>;
}

const defaultDeps: EventSubDeps = {
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  getToken: getValidTwitchToken,
  refreshToken: refreshTwitchToken,
  post: (url, init) => fetchJson(url, init, { timeoutMs: 8000 }),
};

const limit = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

export function eventToAlert(type: string, event: Record<string, unknown>): AlertData | null {
  const user = limit(event.user_name, 50) || 'Someone';
  switch (type) {
    case 'channel.subscribe':
      // Gift recipients also produce channel.subscribe; the gifter's
      // channel.subscription.gift alert already covers them.
      if (event.is_gift) return null;
      return { platform: 'twitch', alert_type: 'sub', user_name: user, message: `${user} just subscribed!` };
    case 'channel.subscription.gift': {
      const gifter = event.is_anonymous ? 'An anonymous gifter' : user;
      const total = typeof event.total === 'number' && event.total > 0 ? event.total : 1;
      return {
        platform: 'twitch',
        alert_type: 'gift',
        user_name: gifter,
        message: `${gifter} gifted ${total} sub${total === 1 ? '' : 's'}!`,
        count: total,
      };
    }
    case 'channel.channel_points_custom_reward_redemption.add': {
      const reward = limit((event.reward as { title?: unknown } | undefined)?.title, 100) || 'a reward';
      return {
        platform: 'twitch',
        alert_type: 'redemption',
        user_name: user,
        message: `${user} redeemed ${reward}!`,
        detail: limit(event.user_input, 200) || undefined,
      };
    }
    default:
      return null;
  }
}

type SubscribeResult = 'ok' | 'auth' | 'forbidden' | 'failed';

interface EventSubMessage {
  metadata?: { message_type?: string; message_id?: string; subscription_type?: string };
  payload?: {
    session?: { id?: string; keepalive_timeout_seconds?: number; reconnect_url?: string };
    subscription?: { type?: string; status?: string };
    event?: Record<string, unknown>;
  };
}

export class TwitchEventSubSession {
  private socket: SocketLike | null = null;
  /** Socket opened for a session_reconnect; replaces `socket` on welcome. */
  private migrating: SocketLike | null = null;
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveMs = 40_000;
  private attempt = 0;
  private stopped = false;
  private readonly seen = new BoundedSet<string>(1000);

  constructor(
    private readonly broadcasterId: string,
    private readonly clientId: string,
    private readonly handlers: EventSubHandlers,
    private readonly deps: EventSubDeps = defaultDeps,
  ) {}

  start(): void {
    this.open(EVENTSUB_URL, false);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    for (const socket of [this.socket, this.migrating]) this.discard(socket);
    this.socket = null;
    this.migrating = null;
  }

  retryNow(): void {
    if (this.stopped || !this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.open(EVENTSUB_URL, false);
  }

  private clearTimers(): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
  }

  private discard(socket: SocketLike | null): void {
    if (!socket) return;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
  }

  private open(url: string, migration: boolean): void {
    if (this.stopped) return;
    const socket = this.deps.createSocket(url);
    if (migration) {
      this.discard(this.migrating);
      this.migrating = socket;
    } else {
      this.socket = socket;
    }
    socket.onmessage = (event) => this.handleMessage(socket, event.data);
    socket.onclose = () => this.handleClose(socket);
    socket.onerror = () => {}; // a close event always follows
    // Also covers a connection that opens but never sends its welcome.
    if (!migration) this.armKeepalive();
  }

  private armKeepalive(): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      // Neither an event nor a keepalive arrived in time: the connection is
      // dead even if the socket hasn't noticed yet.
      const dead = this.socket;
      this.socket = null;
      this.discard(dead);
      this.scheduleReconnect('The alert connection went quiet');
    }, this.keepaliveMs);
  }

  private handleMessage(socket: SocketLike, raw: unknown): void {
    let message: EventSubMessage;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (socket === this.socket) this.armKeepalive();

    switch (message.metadata?.message_type) {
      case 'session_welcome': {
        const session = message.payload?.session;
        this.keepaliveMs = ((session?.keepalive_timeout_seconds ?? 30) + 10) * 1000;
        if (socket === this.migrating) {
          // Subscriptions carry over to the new connection; drop the old one.
          const old = this.socket;
          this.socket = socket;
          this.migrating = null;
          this.discard(old);
          this.armKeepalive();
          return;
        }
        if (socket !== this.socket || !session?.id) return;
        this.armKeepalive(); // with the timeout this session asked for
        void this.subscribeAll(session.id, socket);
        return;
      }
      case 'notification': {
        const id = message.metadata?.message_id;
        // Twitch may deliver a notification more than once.
        if (id && !this.seen.add(id)) return;
        const type = message.payload?.subscription?.type ?? '';
        const alert = eventToAlert(type, message.payload?.event ?? {});
        if (alert) this.handlers.onAlert(alert);
        return;
      }
      case 'session_reconnect': {
        const url = message.payload?.session?.reconnect_url;
        if (url && socket === this.socket) this.open(url, true);
        return;
      }
      case 'revocation':
        this.handlers.onStatus(
          'error',
          `Twitch stopped sending ${message.payload?.subscription?.type ?? 'some'} alerts (${message.payload?.subscription?.status ?? 'revoked'}).`,
        );
        return;
      default:
        return; // session_keepalive: already handled by armKeepalive
    }
  }

  private handleClose(socket: SocketLike): void {
    if (socket === this.migrating) {
      // The migration socket failed; the old one stays in charge until Twitch
      // closes it, and that close triggers a normal reconnect.
      this.migrating = null;
      return;
    }
    if (socket !== this.socket || this.stopped) return;
    this.socket = null;
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.scheduleReconnect('The alert connection dropped');
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempt += 1;
    const delay = backoffDelay(this.attempt);
    this.handlers.onStatus('reconnecting', `${reason}. Retrying in ${Math.ceil(delay / 1000)}s.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open(EVENTSUB_URL, false);
    }, delay);
  }

  private async subscribe(
    subscription: (typeof ALERT_SUBSCRIPTIONS)[number],
    sessionId: string,
    token: string,
  ): Promise<SubscribeResult> {
    try {
      const response = await this.deps.post(SUBSCRIPTIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Client-Id': this.clientId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: subscription.type,
          version: subscription.version,
          condition: { broadcaster_user_id: this.broadcasterId },
          transport: { method: 'websocket', session_id: sessionId },
        }),
      });
      if (response.ok || response.status === 409) return 'ok';
      if (response.status === 401) return 'auth';
      if (response.status === 403) return 'forbidden';
      return 'failed';
    } catch {
      return 'failed';
    }
  }

  private async subscribeAll(sessionId: string, socket: SocketLike): Promise<void> {
    let token = await this.deps.getToken();
    const results: SubscribeResult[] = ALERT_SUBSCRIPTIONS.map(() => 'failed');
    let pending = ALERT_SUBSCRIPTIONS.map((_, i) => i);
    // A second round, with a refreshed token, for whatever Twitch rejected
    // as unauthorized.
    for (let round = 0; round < 2 && pending.length > 0; round += 1) {
      if (token.status === 'signed_out') {
        this.stopped = true;
        this.clearTimers();
        this.discard(socket);
        this.handlers.onStatus('error', 'Your Twitch session expired. Log in again to get alerts.');
        return;
      }
      if (token.status === 'unavailable') break;
      const current = token.token;
      const outcomes = await Promise.all(
        pending.map((i) => this.subscribe(ALERT_SUBSCRIPTIONS[i], sessionId, current)),
      );
      pending.forEach((i, k) => {
        results[i] = outcomes[k];
      });
      pending = pending.filter((i) => results[i] === 'auth');
      if (pending.length > 0) token = await this.deps.refreshToken();
    }
    if (this.stopped || socket !== this.socket) return;

    if (results.every((r) => r === 'failed' || r === 'auth')) {
      // Nothing subscribed. Twitch closes unused sessions after 10 seconds
      // and that close schedules the retry; close now to retry sooner.
      const dead = this.socket;
      this.socket = null;
      this.discard(dead);
      this.scheduleReconnect('Could not subscribe to Twitch alerts');
      return;
    }

    this.attempt = 0;
    const unavailable = ALERT_SUBSCRIPTIONS.filter((_, i) => results[i] !== 'ok').map((s) => s.label);
    this.handlers.onStatus(
      'connected',
      unavailable.length
        ? `Twitch didn't allow ${unavailable.join(', ')} alerts. They need an Affiliate or Partner channel.`
        : undefined,
    );
  }
}
