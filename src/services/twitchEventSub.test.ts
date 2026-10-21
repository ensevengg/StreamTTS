import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TwitchEventSubSession, eventToAlert, type EventSubDeps, type SocketLike } from './twitchEventSub';
import type { AlertData } from './alertsService';
import type { JsonResponse } from '@/lib/http';

class FakeSocket implements SocketLike {
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed = false;

  constructor(readonly url: string) {}

  close() {
    this.closed = true;
  }

  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

const welcome = (id: string) => ({
  metadata: { message_type: 'session_welcome' },
  payload: { session: { id, keepalive_timeout_seconds: 10 } },
});

const notification = (messageId: string, type: string, event: object) => ({
  metadata: { message_type: 'notification', message_id: messageId },
  payload: { subscription: { type }, event },
});

const response = (status: number): JsonResponse => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  body: null,
});

/** Fake timers push 0ms timers created mid-tick to +1ms; step in 1ms rounds. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);
};

function setup() {
  const sockets: FakeSocket[] = [];
  const alerts: AlertData[] = [];
  const statuses: { status: string; detail?: string }[] = [];
  const posts: { type: string; sessionId: string; clientId: string }[] = [];

  const deps: EventSubDeps = {
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    getToken: vi.fn(async () => ({ status: 'ok' as const, token: 'token' })),
    refreshToken: vi.fn(async () => ({ status: 'ok' as const, token: 'fresh' })),
    post: vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      posts.push({
        type: body.type,
        sessionId: body.transport.session_id,
        clientId: (init.headers as Record<string, string>)['Client-Id'],
      });
      return response(202);
    }),
  };
  const session = new TwitchEventSubSession('123', 'client-id', {
    onAlert: (alert) => alerts.push(alert),
    onStatus: (status, detail) => statuses.push({ status, detail }),
  }, deps);
  return { session, sockets, alerts, statuses, posts };
}

describe('TwitchEventSubSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('subscribes to the alert events on the welcomed session', async () => {
    const { session, sockets, posts, statuses } = setup();
    session.start();
    sockets[0].receive(welcome('s1'));
    await settle();

    expect(posts.map(p => p.type)).toEqual([
      'channel.subscribe',
      'channel.subscription.gift',
      'channel.channel_points_custom_reward_redemption.add',
    ]);
    expect(posts.every(p => p.sessionId === 's1' && p.clientId === 'client-id')).toBe(true);
    expect(statuses[statuses.length - 1]).toEqual({ status: 'connected', detail: undefined });
    session.stop();
  });

  it('turns notifications into alerts, once each', async () => {
    const { session, sockets, alerts } = setup();
    session.start();
    sockets[0].receive(welcome('s1'));
    await settle();

    const gift = notification('m1', 'channel.subscription.gift', { user_name: 'Gifter', total: 5 });
    sockets[0].receive(gift);
    sockets[0].receive(gift); // Twitch may redeliver
    expect(alerts).toEqual([expect.objectContaining({ alert_type: 'gift', message: 'Gifter gifted 5 subs!', count: 5 })]);
    session.stop();
  });

  it('moves to the reconnect URL and drops the old socket only after the new welcome', async () => {
    const { session, sockets, posts, alerts } = setup();
    session.start();
    sockets[0].receive(welcome('s1'));
    await settle();

    sockets[0].receive({
      metadata: { message_type: 'session_reconnect' },
      payload: { session: { reconnect_url: 'wss://edge.example/ws' } },
    });
    expect(sockets[1].url).toBe('wss://edge.example/ws');
    expect(sockets[0].closed).toBe(false);

    // Events keep flowing on the old socket during the move.
    sockets[0].receive(notification('m1', 'channel.subscribe', { user_name: 'A' }));
    sockets[1].receive(welcome('s1'));
    await settle();
    expect(sockets[0].closed).toBe(true);
    // Subscriptions carry over; nothing is re-created.
    expect(posts).toHaveLength(3);
    sockets[1].receive(notification('m2', 'channel.subscribe', { user_name: 'B' }));
    expect(alerts.map(a => a.user_name)).toEqual(['A', 'B']);
    session.stop();
  });

  it('reconnects with a fresh session after a drop', async () => {
    const { session, sockets, posts } = setup();
    session.start();
    sockets[0].receive(welcome('s1'));
    await settle();

    sockets[0].drop();
    await vi.advanceTimersByTimeAsync(1500); // first backoff step is at most 1s
    expect(sockets).toHaveLength(2);
    sockets[1].receive(welcome('s2'));
    await settle();
    expect(posts.filter(p => p.sessionId === 's2')).toHaveLength(3);
    session.stop();
  });

  it('treats a silent connection as dead', async () => {
    const { session, sockets, statuses } = setup();
    session.start();
    sockets[0].receive(welcome('s1'));
    await settle();

    await vi.advanceTimersByTimeAsync(21_000); // keepalive (10s) + grace (10s)
    expect(sockets[0].closed).toBe(true);
    expect(statuses[statuses.length - 1].status).toBe('reconnecting');
    session.stop();
  });
});

describe('eventToAlert', () => {
  it('keeps viewer-written redemption text out of the spoken message', () => {
    const alert = eventToAlert('channel.channel_points_custom_reward_redemption.add', {
      user_name: 'V',
      user_input: 'say something rude',
      reward: { title: 'Hydrate' },
    });
    expect(alert?.message).toBe('V redeemed Hydrate!');
    expect(alert?.detail).toBe('say something rude');
  });
});
