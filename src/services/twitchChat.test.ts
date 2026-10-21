import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TwitchChatSession, type ChatClient, type ChatClientOptions } from './twitchChat';
import type { TokenResult } from './twitchService';

/** Stand-in for a tmi.js client that the test drives by emitting events. */
class FakeClient implements ChatClient {
  listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  connectCalls = 0;
  disconnected = false;

  constructor(readonly options: ChatClientOptions) {}

  on(event: string, listener: (...args: never[]) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, list);
    return this;
  }

  removeAllListeners() {
    this.listeners.clear();
    return this;
  }

  connect = async () => {
    this.connectCalls += 1;
    return [];
  };

  async disconnect() {
    this.disconnected = true;
    return [];
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  message(text: string, id = Math.random().toString(36)) {
    this.emit('message', '#channel', { id, 'display-name': 'Viewer' }, text, false);
  }
}

const ok = (token: string): TokenResult => ({ status: 'ok', token });

function setup(tokens: TokenResult[] = [ok('t1')], refreshResult: TokenResult = ok('t2')) {
  const clients: FakeClient[] = [];
  const statuses: string[] = [];
  const messages: string[] = [];
  const getToken = vi.fn(async () => tokens.shift() ?? ok('latest'));
  const refreshToken = vi.fn(async () => refreshResult);
  const session = new TwitchChatSession(
    'streamer',
    {
      onMessage: (m) => messages.push(m.text),
      onStatus: (status) => statuses.push(status),
    },
    {
      createClient: (options) => {
        const client = new FakeClient(options);
        clients.push(client);
        return client;
      },
      getToken,
      refreshToken,
    },
  );
  return { session, clients, statuses, messages, getToken, refreshToken };
}

describe('TwitchChatSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('connects with library reconnects disabled and forwards chat', async () => {
    const { session, clients, statuses, messages } = setup();
    session.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(clients).toHaveLength(1);
    expect(clients[0].options.connection.reconnect).toBe(false);
    expect(clients[0].options.identity.password).toBe('oauth:t1');
    clients[0].emit('connected');
    clients[0].message('!г привет');
    expect(statuses).toEqual(['connecting', 'connected']);
    expect(messages).toEqual(['!г привет']);
  });

  it('keeps reconnecting after drops instead of giving up', async () => {
    const { session, clients, statuses } = setup();
    session.start();
    await vi.advanceTimersByTimeAsync(0);

    for (let drop = 0; drop < 8; drop++) {
      clients[clients.length - 1].emit('disconnected', 'Unable to connect.');
      expect(statuses[statuses.length - 1]).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(31_000);
    }
    expect(clients).toHaveLength(9);
    clients[8].emit('connected');
    expect(statuses[statuses.length - 1]).toBe('connected');
  });

  it("neuters abandoned clients so tmi's RECONNECT can't revive them", async () => {
    const { session, clients, messages } = setup();
    session.start();
    await vi.advanceTimersByTimeAsync(0);
    const old = clients[0];
    old.emit('connected');

    old.emit('disconnected', 'Connection closed.');
    await vi.advanceTimersByTimeAsync(31_000);
    const replacement = clients[1];
    replacement.emit('connected');

    // tmi.js schedules connect() on the old client after a RECONNECT.
    await old.connect();
    old.message('ghost');
    replacement.message('real');

    expect(old.connectCalls).toBe(1); // the replaced connect() didn't count
    expect(old.disconnected).toBe(true);
    expect(messages).toEqual(['real']);
  });

  it('refreshes the token when Twitch rejects the login', async () => {
    const { session, clients, refreshToken } = setup([ok('stale'), ok('fresh')]);
    session.start();
    await vi.advanceTimersByTimeAsync(0);

    clients[0].emit('disconnected', 'Login authentication failed');
    await vi.advanceTimersByTimeAsync(2000);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(clients[1].options.identity.password).toBe('oauth:fresh');
  });

  it('stops and asks for a new login when the session is gone', async () => {
    const { session, clients, statuses } = setup([ok('t1')], { status: 'signed_out' });
    session.start();
    await vi.advanceTimersByTimeAsync(0);

    clients[0].emit('disconnected', 'Login authentication failed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statuses[statuses.length - 1]).toBe('error');
    expect(clients).toHaveLength(1);
  });
});
