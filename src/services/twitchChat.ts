import { Client } from 'tmi.js';
import { backoffDelay } from '@/lib/resilience';
import { getValidTwitchToken, refreshTwitchToken, type TokenResult } from '@/services/twitchService';

export type TwitchChatStatus = 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface TwitchChatMessage {
  id: string;
  username: string;
  text: string;
}

export interface TwitchChatHandlers {
  onMessage: (message: TwitchChatMessage) => void;
  onStatus: (status: TwitchChatStatus, detail?: string) => void;
}

/** The tmi.js options the session uses (tmi.js ships no type declarations). */
export interface ChatClientOptions {
  options: { debug: boolean; skipUpdatingEmotesets: boolean };
  connection: { secure: boolean; reconnect: boolean; timeout: number };
  identity: { username: string; password: string };
  channels: string[];
}

/** The parts of a tmi.js client the session relies on (mockable in tests). */
export interface ChatClient {
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

export interface TwitchChatDeps {
  createClient: (options: ChatClientOptions) => ChatClient;
  getToken: () => Promise<TokenResult>;
  refreshToken: () => Promise<TokenResult>;
}

const defaultDeps: TwitchChatDeps = {
  createClient: (options) => new Client(options) as ChatClient,
  getToken: getValidTwitchToken,
  refreshToken: refreshTwitchToken,
};

const AUTH_FAILURE = /login authentication failed|login unsuccessful|improperly formatted auth|invalid nick/i;
/** After this many back-to-back logins rejected even with a fresh token, stop. */
const MAX_AUTH_FAILURES = 2;

/**
 * Detaches a client the session no longer owns. tmi.js reconnects on Twitch's
 * RECONNECT command even with `reconnect: false`, so an abandoned client must
 * also lose its ability to connect or it comes back as a second reader and
 * every message is spoken twice.
 */
function neuter(client: ChatClient): void {
  client.removeAllListeners();
  client.connect = () => Promise.resolve([]);
  client.disconnect().catch(() => {});
}

/**
 * One channel's chat connection. It reconnects with backoff for as long as
 * the session runs (network drops, ping timeouts, Twitch maintenance) and
 * refreshes the token when Twitch rejects the login. It only gives up when
 * the user has to log in again.
 */
export class TwitchChatSession {
  private client: ChatClient | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private authFailures = 0;
  private stopped = false;

  constructor(
    readonly channel: string,
    private readonly handlers: TwitchChatHandlers,
    private readonly deps: TwitchChatDeps = defaultDeps,
  ) {}

  start(): void {
    this.handlers.onStatus('connecting');
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    if (this.client) neuter(this.client);
    this.client = null;
  }

  /** Skips the backoff wait, e.g. when the OS reports the network is back. */
  retryNow(): void {
    if (this.stopped || !this.timer) return;
    this.clearTimer();
    void this.open();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    const token = await this.deps.getToken();
    if (this.stopped) return;
    if (token.status === 'signed_out') {
      this.fail('Your Twitch session expired. Log in again.');
      return;
    }
    if (token.status === 'unavailable') {
      this.scheduleReconnect('Could not refresh the Twitch login');
      return;
    }

    const client = this.deps.createClient({
      options: { debug: false, skipUpdatingEmotesets: true },
      connection: { secure: true, reconnect: false, timeout: 20_000 },
      identity: { username: this.channel, password: `oauth:${token.token}` },
      channels: [this.channel],
    });
    this.client = client;

    client.on('message', (_channel: string, tags: Record<string, string | undefined>, text: string, self: boolean) => {
      if (self || client !== this.client) return;
      this.handlers.onMessage({
        id: tags.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        username: tags['display-name'] || tags.username || 'Anonymous',
        text,
      });
    });

    client.on('connected', () => {
      if (client !== this.client) return;
      this.attempt = 0;
      this.authFailures = 0;
      this.handlers.onStatus('connected');
    });

    client.on('disconnected', (reason: string) => {
      if (client !== this.client || this.stopped) return;
      void this.handleDrop(reason);
    });

    // Failures surface through 'disconnected' as well; nothing to do here.
    client.connect().catch(() => {});
  }

  private async handleDrop(reason: string): Promise<void> {
    if (this.client) neuter(this.client);
    this.client = null;

    if (AUTH_FAILURE.test(reason)) {
      this.authFailures += 1;
      if (this.authFailures > MAX_AUTH_FAILURES) {
        this.fail('Twitch keeps rejecting the login. Log in again.');
        return;
      }
      const refreshed = await this.deps.refreshToken();
      if (this.stopped) return;
      if (refreshed.status === 'signed_out') {
        this.fail('Your Twitch session expired. Log in again.');
        return;
      }
    }
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.attempt += 1;
    const delay = backoffDelay(this.attempt);
    this.handlers.onStatus(
      'reconnecting',
      `${reason || 'Connection lost'}. Retrying in ${Math.ceil(delay / 1000)}s.`,
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.open();
    }, delay);
  }

  private fail(message: string): void {
    this.stopped = true;
    this.clearTimer();
    this.handlers.onStatus('error', message);
  }
}
