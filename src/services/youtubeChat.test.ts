import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BROADCAST_CHECK_MS,
  MIN_POLL_MS,
  STREAM_RETRY_MS,
  YouTubeChatSession,
  chatItemToAlert,
  classifyYouTubeError,
  type YouTubeChatDeps,
} from './youtubeChat';
import {
  StreamTransportError,
  StreamUnavailableError,
  YouTubeApiError,
  type LiveBroadcast,
  type LiveChatItem,
  type LiveChatPage,
} from './youtubeService';
import type { AlertData } from './alertsService';

const NOW = Date.parse('2026-10-20T12:00:00Z');

const text = (id: string, message: string, minutesAgo = 0): LiveChatItem => ({
  id,
  snippet: {
    type: 'textMessageEvent',
    displayMessage: message,
    publishedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
  },
  authorDetails: { displayName: 'Viewer' },
});

const broadcast = (liveChatId: string, title = 'Stream'): LiveBroadcast => ({
  id: `b-${liveChatId}`,
  snippet: { title, liveChatId },
});

/**
 * Runs due timers and the promise chains they start, a few rounds deep. Steps
 * 1ms at a time: fake timers push a 0ms timer created mid-tick to +1ms.
 */
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(1);
};

const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
};

type PageStep = LiveChatPage | Error;

interface SetupOptions {
  broadcasts: LiveBroadcast[][];
  pages: PageStep[];
  /** Defaults to "streaming unavailable", which exercises the polling fallback. */
  openStream?: YouTubeChatDeps['openStream'];
  now?: () => number;
}

function setup({ broadcasts, pages, openStream, now }: SetupOptions) {
  const messages: string[] = [];
  const alerts: AlertData[] = [];
  const statuses: string[] = [];
  const titles: string[] = [];
  const pageRequests: { liveChatId: string; pageToken: string | null }[] = [];

  const deps: YouTubeChatDeps = {
    getToken: vi.fn(async () => ({ status: 'ok' as const, token: 'token' })),
    invalidateToken: vi.fn(async () => {}),
    fetchBroadcasts: vi.fn(async () => broadcasts.length > 1 ? broadcasts.shift()! : broadcasts[0] ?? []),
    fetchPage: vi.fn(async (_token: string, liveChatId: string, pageToken: string | null) => {
      pageRequests.push({ liveChatId, pageToken });
      const step = pages.shift() ?? { items: [], nextPageToken: pageToken ?? 'p', pollingIntervalMillis: MIN_POLL_MS };
      if (step instanceof Error) throw step;
      return step;
    }),
    openStream: openStream ?? vi.fn(async () => {
      throw new StreamUnavailableError('no desktop backend in tests');
    }),
    now: now ?? (() => NOW),
  };

  const session = new YouTubeChatSession(
    {
      onMessage: (m) => messages.push(m.text),
      onAlert: (a) => alerts.push(a),
      onStatus: (status) => statuses.push(status),
      onBroadcast: (title) => titles.push(title),
    },
    deps,
  );
  return { session, deps, messages, alerts, statuses, titles, pageRequests };
}

describe('YouTubeChatSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('skips the backlog on connect, then reads new messages', async () => {
    const { session, messages, statuses, titles } = setup({
      broadcasts: [[broadcast('chat1', 'My stream')]],
      pages: [
        { items: [text('old1', '!г old', 5), text('old2', 'old', 1)], nextPageToken: 'p1', pollingIntervalMillis: 1000 },
        { items: [text('new1', '!г hello')], nextPageToken: 'p2' },
      ],
    });
    session.start();
    await settle();
    expect(messages).toEqual([]);
    expect(titles).toEqual(['My stream']);
    expect(statuses).toEqual(['connecting', 'connected']);

    await advance(MIN_POLL_MS);
    expect(messages).toEqual(['!г hello']);
    session.stop();
  });

  it('never polls faster than the quota floor', async () => {
    const { session, pageRequests } = setup({
      broadcasts: [[broadcast('chat1')]],
      pages: [{ items: [], nextPageToken: 'p1', pollingIntervalMillis: 500 }],
    });
    session.start();
    await settle();
    await advance(MIN_POLL_MS - 100);
    expect(pageRequests).toHaveLength(1);
    await advance(200);
    expect(pageRequests).toHaveLength(2);
    session.stop();
  });

  it('rides out network errors and resumes where it left off, without replays', async () => {
    const { session, messages, statuses, pageRequests } = setup({
      broadcasts: [[broadcast('chat1')]],
      pages: [
        { items: [], nextPageToken: 'p1' },
        new TypeError('Failed to fetch'),
        new TypeError('Failed to fetch'),
        new TypeError('Failed to fetch'),
        new TypeError('Failed to fetch'),
        { items: [text('m1', 'after outage')], nextPageToken: 'p2' },
      ],
    });
    session.start();
    await settle();
    // Four failures in a row: the old poller gave up after three.
    await advance(5 * 60_000);

    expect(statuses).toContain('reconnecting');
    expect(statuses[statuses.length - 1]).toBe('connected');
    expect(messages).toEqual(['after outage']);
    // The four retries and the recovery all resumed from the same cursor.
    expect(pageRequests.slice(1, 6).map(r => r.pageToken)).toEqual(['p1', 'p1', 'p1', 'p1', 'p1']);
    session.stop();
  });

  it('waits for the stream to go live instead of failing', async () => {
    const { session, statuses, titles } = setup({
      broadcasts: [[], [broadcast('chat1', 'Live now')]],
      pages: [],
    });
    session.start();
    await settle();
    expect(statuses[statuses.length - 1]).toBe('waiting');

    await advance(BROADCAST_CHECK_MS);
    expect(titles).toEqual(['Live now']);
    expect(statuses[statuses.length - 1]).toBe('connected');
    session.stop();
  });

  it('after a stream crash, attaches to the next broadcast and reads what was missed', async () => {
    const { session, messages, statuses, pageRequests } = setup({
      broadcasts: [[broadcast('chat1')], [broadcast('chat1')], [broadcast('chat2', 'Restarted')]],
      pages: [
        { items: [], nextPageToken: 'p1' },
        new YouTubeApiError(403, 'liveChatEnded', 'The live chat is no longer live.'),
        { items: [text('gap', 'sent during the crash', 0)], nextPageToken: 'q1' },
      ],
    });
    session.start();
    await settle();
    await advance(MIN_POLL_MS);
    expect(statuses[statuses.length - 1]).toBe('waiting');

    // The ended chat is still listed for a while; it must not be re-attached.
    await advance(BROADCAST_CHECK_MS);
    expect(pageRequests.map(r => r.liveChatId)).toEqual(['chat1', 'chat1']);

    await advance(BROADCAST_CHECK_MS);
    expect(pageRequests[pageRequests.length - 1].liveChatId).toBe('chat2');
    expect(messages).toEqual(['sent during the crash']);
    session.stop();
  });

  it('treats chatEndedEvent like an ended chat', async () => {
    const { session, statuses } = setup({
      broadcasts: [[broadcast('chat1')], []],
      pages: [
        { items: [], nextPageToken: 'p1' },
        { items: [{ id: 'end', snippet: { type: 'chatEndedEvent' } }], nextPageToken: 'p2' },
      ],
    });
    session.start();
    await advance(MIN_POLL_MS);
    expect(statuses[statuses.length - 1]).toBe('waiting');
    session.stop();
  });

  it('stops with a clear message when the daily quota is gone', async () => {
    const { session, statuses, pageRequests } = setup({
      broadcasts: [[broadcast('chat1')]],
      pages: [new YouTubeApiError(403, 'quotaExceeded', 'quota')],
    });
    session.start();
    await settle();
    expect(statuses[statuses.length - 1]).toBe('error');
    await advance(10 * 60_000);
    expect(pageRequests).toHaveLength(1);
  });

  it('forces a token refresh after a 401 and retries', async () => {
    const { session, deps, statuses } = setup({
      broadcasts: [[broadcast('chat1')]],
      pages: [new YouTubeApiError(401, 'authError', 'Invalid Credentials'), { items: [], nextPageToken: 'p1' }],
    });
    session.start();
    await advance(2000);
    expect(deps.invalidateToken).toHaveBeenCalledTimes(1);
    expect(statuses[statuses.length - 1]).toBe('connected');
    session.stop();
  });

  it('ends the session when the login is gone', async () => {
    const { session, deps, statuses } = setup({ broadcasts: [[broadcast('chat1')]], pages: [] });
    vi.mocked(deps.getToken).mockResolvedValue({ status: 'signed_out' });
    session.start();
    await settle();
    expect(statuses[statuses.length - 1]).toBe('error');
  });

  it('turns Super Chats into alerts, not TTS messages', async () => {
    const superChat: LiveChatItem = {
      id: 'sc1',
      snippet: {
        type: 'superChatEvent',
        publishedAt: new Date(NOW).toISOString(),
        superChatDetails: { amountDisplayString: '$5.00', userComment: 'great stream' },
      },
      authorDetails: { displayName: 'Fan' },
    };
    const { session, messages, alerts } = setup({
      broadcasts: [[broadcast('chat1')]],
      pages: [{ items: [], nextPageToken: 'p1' }, { items: [superChat], nextPageToken: 'p2' }],
    });
    session.start();
    await advance(MIN_POLL_MS);
    expect(messages).toEqual([]);
    expect(alerts).toEqual([
      expect.objectContaining({ alert_type: 'superchat', message: 'Fan sent a $5.00 Super Chat!', detail: 'great stream' }),
    ]);
    session.stop();
  });
});

describe('classifyYouTubeError', () => {
  it('retries rate limits and server errors', () => {
    expect(classifyYouTubeError(new YouTubeApiError(403, 'rateLimitExceeded', '')).kind).toBe('transient');
    expect(classifyYouTubeError(new YouTubeApiError(503, '', '')).kind).toBe('transient');
    expect(classifyYouTubeError(new TypeError('Failed to fetch')).kind).toBe('transient');
  });

  it('distinguishes permanent failures', () => {
    expect(classifyYouTubeError(new YouTubeApiError(403, 'forbidden', '')).kind).toBe('fatal');
    expect(classifyYouTubeError(new YouTubeApiError(404, 'liveChatNotFound', '')).kind).toBe('chat_ended');
  });
});

describe('chatItemToAlert', () => {
  it('maps memberships and gifts', () => {
    expect(chatItemToAlert({
      id: '1',
      snippet: { type: 'membershipGiftingEvent', membershipGiftingDetails: { giftMembershipsCount: 5 } },
      authorDetails: { displayName: 'Gifter' },
    })).toEqual(expect.objectContaining({ alert_type: 'member', count: 5, message: 'Gifter gifted 5 memberships!' }));

    expect(chatItemToAlert({ id: '2', snippet: { type: 'newSponsorEvent' }, authorDetails: { displayName: 'New' } }))
      .toEqual(expect.objectContaining({ message: 'New just became a member!' }));
  });

  it('ignores plain chat', () => {
    expect(chatItemToAlert(text('1', 'hi'))).toBeNull();
  });
});

/**
 * A stand-in for streamLiveChat: each open() call becomes a stream the test
 * feeds pages into and then closes or fails.
 */
function fakeStreams() {
  const opened: {
    pageToken: string | null;
    push: (page: LiveChatPage) => void;
    close: () => void;
    fail: (error: Error) => void;
    aborted: () => boolean;
  }[] = [];
  const openStream: YouTubeChatDeps['openStream'] = vi.fn((_token, _chatId, pageToken, onPage, signal) =>
    new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
      opened.push({ pageToken, push: onPage, close: resolve, fail: reject, aborted: () => signal.aborted });
    }),
  );
  return { opened, openStream };
}

describe('YouTubeChatSession streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('reads chat from one open stream without polling', async () => {
    const streams = fakeStreams();
    const { session, messages, statuses, pageRequests } = setup({
      broadcasts: [[broadcast('chat1')]],
      pages: [],
      openStream: streams.openStream,
    });
    session.start();
    await settle();
    expect(streams.opened).toHaveLength(1);

    streams.opened[0].push({ items: [text('old', '!г backlog', 2)], nextPageToken: 'p1' });
    streams.opened[0].push({ items: [text('n1', '!г one')], nextPageToken: 'p2' });
    streams.opened[0].push({ items: [text('n2', '!г two'), text('n1', '!г one')], nextPageToken: 'p3' });
    await advance(10 * 60_000);

    expect(messages).toEqual(['!г one', '!г two']);
    expect(statuses[statuses.length - 1]).toBe('connected');
    expect(pageRequests).toHaveLength(0);
    expect(streams.opened).toHaveLength(1); // still the same connection
    session.stop();
  });

  it('reopens a stream YouTube closed, from the last page, no sooner than a poll would run', async () => {
    const streams = fakeStreams();
    const { session } = setup({
      broadcasts: [[broadcast('chat1')]],
      pages: [],
      openStream: streams.openStream,
      now: () => Date.now(),
    });
    session.start();
    await settle();
    streams.opened[0].push({ items: [], nextPageToken: 'p1' });
    streams.opened[0].close();
    await settle();
    // Closed almost immediately: the next stream waits out the quota floor.
    expect(streams.opened).toHaveLength(1);

    await advance(MIN_POLL_MS);
    expect(streams.opened).toHaveLength(2);
    expect(streams.opened[1].pageToken).toBe('p1');

    // A stream that stayed open longer than the floor reopens right away.
    await advance(60_000);
    streams.opened[1].close();
    await settle();
    expect(streams.opened).toHaveLength(3);
    session.stop();
  });

  it('falls back to polling when gRPC keeps failing to connect', async () => {
    const streams = fakeStreams();
    const { session, statuses, pageRequests } = setup({
      broadcasts: [[broadcast('chat1')]],
      pages: [{ items: [], nextPageToken: 'p1' }],
      openStream: streams.openStream,
    });
    session.start();
    await settle();
    for (let attempt = 0; attempt < 3; attempt++) {
      streams.opened[attempt].fail(new StreamTransportError('connect error'));
      await advance(61_000);
    }

    expect(streams.opened).toHaveLength(3);
    expect(pageRequests.length).toBeGreaterThan(0);
    expect(statuses[statuses.length - 1]).toBe('connected');
    session.stop();
  });

  it('goes back to streaming after a fallback, in case it was only an outage', async () => {
    const streams = fakeStreams();
    const { session, pageRequests } = setup({
      broadcasts: [[broadcast('chat1')]],
      pages: [],
      openStream: streams.openStream,
      now: () => Date.now(),
    });
    session.start();
    await settle();
    for (let attempt = 0; attempt < 3; attempt++) {
      streams.opened[attempt].fail(new StreamTransportError('offline'));
      await advance(61_000);
    }
    const pollsWhileFallenBack = pageRequests.length;
    expect(pollsWhileFallenBack).toBeGreaterThan(0);

    await advance(STREAM_RETRY_MS);
    expect(streams.opened).toHaveLength(4);
    // Back on the stream: polling has stopped.
    const pollsAtSwitch = pageRequests.length;
    await advance(60_000);
    expect(pageRequests.length).toBe(pollsAtSwitch);
    session.stop();
  });

  it('a failed retry goes straight back to polling and waits twice as long next time', async () => {
    const streams = fakeStreams();
    const { session, statuses } = setup({
      broadcasts: [[broadcast('chat1')]],
      pages: [],
      openStream: streams.openStream,
      now: () => Date.now(),
    });
    session.start();
    await settle();
    for (let attempt = 0; attempt < 3; attempt++) {
      streams.opened[attempt].fail(new StreamTransportError('blocked'));
      await advance(61_000);
    }
    await advance(STREAM_RETRY_MS);
    expect(streams.opened).toHaveLength(4);

    const before = statuses.length;
    streams.opened[3].fail(new StreamTransportError('still blocked'));
    await settle();
    // No backoff wait: chat keeps being polled.
    expect(statuses.slice(before)).not.toContain('reconnecting');

    await advance(STREAM_RETRY_MS);
    expect(streams.opened).toHaveLength(4);
    await advance(STREAM_RETRY_MS + MIN_POLL_MS);
    expect(streams.opened).toHaveLength(5);
    session.stop();
  });

  it('ignores a late error from a stream whose chat already ended', async () => {
    const streams = fakeStreams();
    const { session, statuses } = setup({
      broadcasts: [[broadcast('chat1')], []],
      pages: [],
      openStream: streams.openStream,
    });
    session.start();
    await settle();
    streams.opened[0].push({ items: [{ id: 'end', snippet: { type: 'chatEndedEvent' } }], nextPageToken: 'p1' });
    streams.opened[0].fail(new StreamTransportError('connection reset'));
    await settle();
    expect(statuses[statuses.length - 1]).toBe('waiting');
    expect(statuses).not.toContain('reconnecting');
    session.stop();
  });

  it('handles stream errors like poll errors', async () => {
    const streams = fakeStreams();
    const { session, statuses } = setup({
      broadcasts: [[broadcast('chat1')], []],
      pages: [],
      openStream: streams.openStream,
    });
    session.start();
    await settle();
    streams.opened[0].push({ items: [], nextPageToken: 'p1' });
    streams.opened[0].fail(new YouTubeApiError(403, 'liveChatEnded', 'LIVE_CHAT_ENDED'));
    await settle();
    expect(statuses[statuses.length - 1]).toBe('waiting');
    session.stop();
  });

  it('stop() closes the open stream', async () => {
    const streams = fakeStreams();
    const { session } = setup({ broadcasts: [[broadcast('chat1')]], pages: [], openStream: streams.openStream });
    session.start();
    await settle();
    session.stop();
    expect(streams.opened[0].aborted()).toBe(true);
  });
});
