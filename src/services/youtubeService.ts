import { invoke, isSignedOutError, isTauriAvailable, type RefreshedTokens } from '@/lib/tauri-api';
import { secureGet, secureSet, secureDelete } from '@/lib/secureStorage';
import { errorMessage } from '@/lib/http';

const YOUTUBE_TOKEN_KEY = 'youtube_oauth_tokens';
/** Refresh this long before the 1-hour access token runs out. */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

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

/** The access token for the requests below, or the error to show instead. */
const requireToken = async (): Promise<string> => {
  const result = await getValidYoutubeToken();
  if (result.status === 'ok') return result.token;
  throw new Error(result.status === 'signed_out'
    ? 'Please log in to YouTube first.'
    : `Couldn't reach YouTube: ${result.reason}`);
};

export const fetchYouTubeLiveBroadcasts = async (): Promise<any[]> => {
  try {
    const token = await requireToken();

    if (typeof token !== 'string' || token.trim().length === 0) {
      console.error("YouTube Service: Invalid token format");
      throw new Error('Your session is invalid. Please log in again.');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 20000);
    
    const response = await fetch(
      'https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,contentDetails&broadcastStatus=active',
      {
        headers: {
          Authorization: `Bearer ${token}`
        },
        signal: controller.signal
      }
    );
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch (parseError) {
        errorData = { error: { message: `HTTP ${response.status}` } };
      }
      console.error('YouTube API error:', errorData);
      
      if (response.status === 401) {
        await clearYoutubeOAuthToken();
        throw new Error('Your YouTube session has expired. Please log in again.');
      }
      
      if (response.status === 403) {
        const errorText = await response.text();
        if (errorText.includes('quotaExceeded') || errorText.includes('dailyLimitExceeded')) {
          throw new Error("YouTube's daily limit reached. Please try again tomorrow.");
        } else if (errorText.includes('liveStreamingNotEnabled')) {
          throw new Error('Live streaming is not enabled on your channel. Enable it in YouTube Studio.');
        } else if (errorText.includes('insufficientPermissions')) {
          throw new Error('Permission denied. Please log out and log back in.');
        } else {
          throw new Error('Access denied. Please log out and log back in.');
        }
      }
      
      const errorMessage = errorData.error?.message || 'Unknown error';
      throw new Error(`Something went wrong. Please try again.`);
    }

    let data;
    try {
      data = await response.json();
    } catch (jsonError) {
      console.error("YouTube Service: Failed to parse JSON response:", jsonError);
      throw new Error('Something went wrong. Please try again.');
    }
    
    if (!data || typeof data !== 'object') {
      console.error("YouTube Service: Invalid response structure:", data);
      throw new Error('Something went wrong. Please try again.');
    }
    
    if (!data.items || data.items.length === 0) {
      return [];
    }
    
    return data.items;
  } catch (error) {
    console.error('Error fetching YouTube broadcasts:', error);
    
    if (error instanceof Error && error.name === 'AbortError') {
      console.error('YouTube Service: Broadcast fetch timed out');
      throw new Error('Could not connect to YouTube. Check your internet and try again.');
    }
    
    console.error('YouTube Service: Error fetching broadcasts:', error);
    throw error;
  }
};

async function fetchLiveChatId(broadcastId: string): Promise<string> {
  const token = await requireToken();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,contentDetails&id=${broadcastId}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }
  );
  clearTimeout(timeout);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }));
    if (response.status === 401) { await clearYoutubeOAuthToken(); throw new Error('Your YouTube session has expired. Please log in again.'); }
    if (response.status === 403) throw new Error('Permission denied. Please log out and log back in.');
    throw new Error('Something went wrong. Please try again.');
  }

  const data = await response.json();
  if (!data.items?.length) throw new Error('Stream not found. It may have ended.');
  if (!data.items[0].snippet.liveChatId) throw new Error('Chat is not available. The stream may have ended.');
  return data.items[0].snippet.liveChatId;
}

class YouTubeChatPoller {
  private liveChatId: string;
  private onMessage: (message: any) => void;
  private onError: (error: Error) => void;
  private nextPageToken: string | null = null;
  private errorCount = 0;
  private isConnected = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly MAX_ERRORS = 3;

  constructor(liveChatId: string, onMessage: (message: any) => void, onError: (error: Error) => void) {
    this.liveChatId = liveChatId;
    this.onMessage = onMessage;
    this.onError = onError;
  }

  start(): void {
    this.isConnected = true;
    this.timeoutId = setTimeout(() => this.poll(), 1000);
  }

  disconnect(): void {
    this.isConnected = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.isConnected) return;

    try {
      const token = await requireToken();

      const url = new URL('https://www.googleapis.com/youtube/v3/liveChat/messages');
      url.searchParams.append('part', 'snippet,authorDetails');
      url.searchParams.append('liveChatId', this.liveChatId);
      url.searchParams.append('maxResults', '200');
      if (this.nextPageToken) url.searchParams.append('pageToken', this.nextPageToken);

      const controller = new AbortController();
      const fetchTimeout = setTimeout(() => controller.abort(), 20000);

      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(fetchTimeout);

      if (!response.ok) {
        await this.handleApiError(response);
        return;
      }

      const data = await response.json();
      this.nextPageToken = data.nextPageToken;
      this.errorCount = 0;

      if (data.items?.length > 0) {
        for (const msg of data.items) {
          if (msg.snippet?.type === 'textMessageEvent') {
            this.onMessage({
              id: msg.id,
              authorDetails: msg.authorDetails,
              snippet: msg.snippet,
              userColor: generateColorFromChannelId(msg.authorDetails.channelId),
            });
          }
        }
      }

      if (this.isConnected) {
        const interval = data.pollingIntervalMillis || 10000;
        this.timeoutId = setTimeout(() => this.poll(), interval);
      }
    } catch (error) {
      await this.handlePollError(error);
    }
  }

  private async handleApiError(response: Response): Promise<void> {
    const errorData = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }));
    console.error('YouTube chat API error:', errorData);

    if (response.status === 401) { await clearYoutubeOAuthToken(); throw new Error('Your YouTube session has expired. Please log in again.'); }
    if (response.status === 403) throw new Error('Permission denied. Please log out and log back in.');
    if (response.status === 429) throw new Error('Too many requests. Wait a moment and try again.');
    throw new Error('Something went wrong. Please try again.');
  }

  private async handlePollError(error: unknown): Promise<void> {
    this.errorCount++;
    console.error('YouTube chat poll error:', error);

    if (this.errorCount >= this.MAX_ERRORS) {
      console.error(`YouTube: Too many consecutive errors (${this.errorCount}), stopping polling`);
      this.onError(error instanceof Error ? error : new Error(String(error)));
      this.isConnected = false;
      return;
    }

    if (this.isConnected) {
      const delay = Math.min(15000 * this.errorCount, 60000);
      this.timeoutId = setTimeout(() => this.poll(), delay);
    }
  }
}

export const connectToYouTubeLiveChat = async (
  broadcastId: string,
  onMessage: (message: any) => void,
  onError: (error: Error) => void
): Promise<{ disconnect: () => void }> => {
  try {
    const liveChatId = await fetchLiveChatId(broadcastId);
    const poller = new YouTubeChatPoller(liveChatId, onMessage, onError);
    poller.start();
    return { disconnect: () => poller.disconnect() };
  } catch (error) {
    console.error('Error connecting to YouTube chat:', error);

    if (error instanceof Error && error.name === 'AbortError') {
      const timeoutError = new Error('Could not connect to YouTube. Please try again.');
      onError(timeoutError);
      throw timeoutError;
    }

    onError(error as Error);
    throw error;
  }
};

export function generateColorFromChannelId(channelId: string): string {
  let hash = 0;
  for (let i = 0; i < channelId.length; i++) {
    hash = channelId.charCodeAt(i) + ((hash << 5) - hash);
  }

  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 70%, 50%)`;
}
