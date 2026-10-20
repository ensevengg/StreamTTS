import { Channel, invoke, isSignedOutError, isTauriAvailable, type RefreshedTokens } from '@/lib/tauri-api';
import { secureGet, secureSet, secureDelete } from '@/lib/secureStorage';
import { errorMessage, fetchJson } from '@/lib/http';

const YOUTUBE_TOKEN_KEY = 'youtube_oauth_tokens';
const API_BASE = 'https://www.googleapis.com/youtube/v3';
/** Refresh this long before the 1-hour access token runs out. */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

export interface YouTubeTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

/** Same contract as the Twitch service: `unavailable` is retryable. */
export type TokenResult =
  | { status: 'ok'; token: string }
  | { status: 'signed_out' }
  | { status: 'unavailable'; reason: string };

// Bumped on logout so an in-flight refresh can't restore a cleared session.
let sessionGeneration = 0;
let refreshInFlight: Promise<TokenResult> | null = null;

const getStoredTokens = async (): Promise<YouTubeTokens | null> => {
  try {
    const stored = await secureGet(YOUTUBE_TOKEN_KEY);
    if (!stored) return null;
    return JSON.parse(stored) as YouTubeTokens;
  } catch {
    return null;
  }
};

export const hasYoutubeOAuthToken = async (): Promise<boolean> =>
  !!(await getStoredTokens())?.access_token;

export const saveYoutubeTokens = async (tokens: YouTubeTokens): Promise<void> => {
  await secureSet(YOUTUBE_TOKEN_KEY, JSON.stringify(tokens));
};

export const clearYoutubeOAuthToken = async (): Promise<void> => {
  sessionGeneration += 1;
  await secureDelete(YOUTUBE_TOKEN_KEY);
};

const doRefresh = async (): Promise<TokenResult> => {
  const tokens = await getStoredTokens();
  if (!tokens?.refresh_token) return { status: 'signed_out' };
  if (!isTauriAvailable()) {
    return { status: 'unavailable', reason: 'Token refresh requires the StreamTTS desktop app' };
  }

  const generation = sessionGeneration;
  try {
    const data = await invoke<RefreshedTokens>('youtube_refresh_token', {
      refreshToken: tokens.refresh_token,
    });
    if (generation !== sessionGeneration) return { status: 'signed_out' };
    await saveYoutubeTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
    });
    return { status: 'ok', token: data.access_token };
  } catch (error) {
    if (isSignedOutError(error)) {
      if (generation === sessionGeneration) await clearYoutubeOAuthToken();
      return { status: 'signed_out' };
    }
    return { status: 'unavailable', reason: errorMessage(error) };
  }
};

/** Concurrent callers share one refresh request. */
const refreshYoutubeToken = (): Promise<TokenResult> => {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
};

export const getValidYoutubeToken = async (): Promise<TokenResult> => {
  const tokens = await getStoredTokens();
  if (!tokens?.access_token) return { status: 'signed_out' };
  if (Date.now() < tokens.expires_at - TOKEN_EXPIRY_BUFFER_MS) {
    return { status: 'ok', token: tokens.access_token };
  }

  const refreshed = await refreshYoutubeToken();
  if (refreshed.status !== 'unavailable') return refreshed;
  // Refresh failed for now; the current token still works until it expires.
  return Date.now() < tokens.expires_at ? { status: 'ok', token: tokens.access_token } : refreshed;
};

/** After a 401 the stored token is dead even if our clock disagrees. */
export const invalidateYoutubeAccessToken = async (): Promise<void> => {
  const tokens = await getStoredTokens();
  if (tokens) await saveYoutubeTokens({ ...tokens, expires_at: 0 });
};

export class YouTubeApiError extends Error {
  constructor(
    readonly status: number,
    /** errors[0].reason from the API body, e.g. quotaExceeded, liveChatEnded. */
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'YouTubeApiError';
  }
}

export const parseYouTubeError = (status: number, body: unknown): YouTubeApiError => {
  const error = (body as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } })?.error;
  const reason = error?.errors?.[0]?.reason ?? error?.status ?? '';
  return new YouTubeApiError(status, reason, error?.message || `YouTube API error ${status}`);
};

const youtubeGet = async (
  path: string,
  params: Record<string, string>,
  token: string,
  signal?: AbortSignal,
): Promise<unknown> => {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchJson(
    url.toString(),
    { headers: { Authorization: `Bearer ${token}` } },
    { timeoutMs: REQUEST_TIMEOUT_MS, signal },
  );
  if (!response.ok) throw parseYouTubeError(response.status, response.body);
  return response.body;
};

export interface LiveBroadcast {
  id: string;
  snippet?: { title?: string; liveChatId?: string };
}

/**
 * The signed-in channel's live broadcasts. broadcastType=all matters: the API
 * default ("event") leaves out persistent "Stream now" broadcasts.
 */
export const fetchActiveBroadcasts = async (token: string, signal?: AbortSignal): Promise<LiveBroadcast[]> => {
  const body = await youtubeGet(
    'liveBroadcasts',
    { part: 'snippet', broadcastStatus: 'active', broadcastType: 'all', maxResults: '10' },
    token,
    signal,
  ) as { items?: LiveBroadcast[] };
  return body?.items ?? [];
};

export interface LiveChatItem {
  id: string;
  snippet?: {
    type?: string;
    publishedAt?: string;
    displayMessage?: string;
    superChatDetails?: { amountDisplayString?: string; userComment?: string };
    superStickerDetails?: { amountDisplayString?: string };
    newSponsorDetails?: { memberLevelName?: string; isUpgrade?: boolean };
    membershipGiftingDetails?: { giftMembershipsCount?: number };
    memberMilestoneChatDetails?: { memberMonth?: number; userComment?: string };
  };
  authorDetails?: { displayName?: string; channelId?: string };
}

export interface LiveChatPage {
  items?: LiveChatItem[];
  nextPageToken?: string;
  pollingIntervalMillis?: number;
}

export const fetchLiveChatPage = async (
  token: string,
  liveChatId: string,
  pageToken: string | null,
  signal?: AbortSignal,
): Promise<LiveChatPage> => {
  const params: Record<string, string> = { liveChatId, part: 'snippet,authorDetails', maxResults: '200' };
  if (pageToken) params.pageToken = pageToken;
  return await youtubeGet('liveChat/messages', params, token, signal) as LiveChatPage;
};

export const fetchOwnChannelTitle = async (token: string): Promise<string | null> => {
  const body = await youtubeGet('channels', { part: 'snippet', mine: 'true' }, token) as {
    items?: { snippet?: { title?: string } }[];
  };
  return body?.items?.[0]?.snippet?.title ?? null;
};

/** Streaming isn't possible here (no desktop backend, or YouTube refused the method). */
export class StreamUnavailableError extends Error {
  name = 'StreamUnavailableError';
}

/** The gRPC connection to YouTube couldn't be made at all. */
export class StreamTransportError extends Error {
  name = 'StreamTransportError';
}

interface StreamFailure {
  status: number;
  reason: string;
  message: string;
}

type StreamEvent =
  | { event: 'page'; page: LiveChatPage }
  | { event: 'end'; error: StreamFailure | null };

const streamFailureToError = (failure: StreamFailure): Error => {
  if (failure.reason === 'streamUnsupported') return new StreamUnavailableError(failure.message);
  if (failure.status === 0) return new StreamTransportError(failure.message);
  return new YouTubeApiError(failure.status, failure.reason, failure.message);
};

let nextStreamId = 1;

/**
 * Receives live chat over liveChatMessages.streamList (see
 * youtube_stream.rs): YouTube pushes pages down one long-lived call instead
 * of being polled, which costs a fraction of the daily quota. Resolves when
 * YouTube closes the stream or `signal` aborts; rejects with the same
 * YouTubeApiError a poll would, or with StreamUnavailableError /
 * StreamTransportError when streaming itself doesn't work.
 */
export const streamLiveChat = (
  token: string,
  liveChatId: string,
  pageToken: string | null,
  onPage: (page: LiveChatPage) => void,
  signal: AbortSignal,
): Promise<void> => {
  if (!isTauriAvailable()) {
    return Promise.reject(new StreamUnavailableError('Streaming chat needs the StreamTTS desktop app'));
  }
  const streamId = nextStreamId++;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      invoke('youtube_chat_stream_stop', { streamId }).catch(() => {});
      finish();
    };
    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    // Pages and the final event share one channel, so they arrive in order.
    const channel = new Channel<StreamEvent>();
    channel.onmessage = (event) => {
      if (settled) return;
      if (event.event === 'page') {
        onPage(event.page);
      } else {
        finish(event.error ? streamFailureToError(event.error) : undefined);
      }
    };
    invoke('youtube_chat_stream', { streamId, accessToken: token, liveChatId, pageToken, onEvent: channel })
      .catch((error) => finish(new StreamUnavailableError(errorMessage(error))));
  });
};
