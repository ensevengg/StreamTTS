import { Client } from 'tmi.js';
import { invoke, isSignedOutError, isTauriAvailable, type RefreshedTokens } from '@/lib/tauri-api';
import { secureGet, secureSet, secureDelete } from '@/lib/secureStorage';
import { errorMessage, fetchJson } from '@/lib/http';

type MessageCallback = (username: string, message: string) => void;
type ConnectionCallback = (connected: boolean, error?: string) => void;

// Stored in the OS keychain (localStorage only outside the desktop app).
const TWITCH_TOKEN_KEY = 'twitch_oauth_token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
/** Refresh this long before the 4-hour access token runs out. */
const TOKEN_EXPIRY_BUFFER_MS = 10 * 60 * 1000;

interface TwitchTokenInfo {
  token: string;
  refresh_token?: string;
  /** Epoch ms when the access token expires, if known. */
  expires_at?: number;
  timestamp: number;
}

export interface TwitchIdentity {
  login: string;
  userId: string;
  clientId: string;
  scopes: string[];
}

/**
 * `unavailable` means "can't get a token right now" (offline, Twitch down):
 * callers retry later instead of signing the user out.
 */
export type TokenResult =
  | { status: 'ok'; token: string }
  | { status: 'signed_out' }
  | { status: 'unavailable'; reason: string };

export type SessionCheck =
  | { status: 'valid'; identity: TwitchIdentity }
  | { status: 'signed_out' }
  | { status: 'unreachable' };

// Bumped on logout so a refresh that was already in flight can't write
// tokens back and silently sign the user in again.
let sessionGeneration = 0;
let refreshInFlight: Promise<TokenResult> | null = null;
let cachedIdentity: { token: string; identity: TwitchIdentity } | null = null;

export const saveTwitchTokens = async (
  token: string,
  refreshToken?: string,
  expiresIn?: number,
): Promise<void> => {
  const tokenInfo: TwitchTokenInfo = {
    token,
    refresh_token: refreshToken || undefined,
    expires_at: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    timestamp: Date.now(),
  };
  await secureSet(TWITCH_TOKEN_KEY, JSON.stringify(tokenInfo));
};

const getTwitchTokenInfo = async (): Promise<TwitchTokenInfo | null> => {
  try {
    const stored = await secureGet(TWITCH_TOKEN_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    // Very old builds stored the bare token string.
    if (typeof parsed === 'string') return { token: parsed, timestamp: 0 };
    return parsed as TwitchTokenInfo;
  } catch (error) {
    console.error("TwitchService: Error reading token info:", error);
    return null;
  }
};

export const hasTwitchOAuthToken = async (): Promise<boolean> =>
  !!(await getTwitchTokenInfo())?.token;

export const clearTwitchOAuthToken = async (): Promise<void> => {
  sessionGeneration += 1;
  cachedIdentity = null;
  try {
    await secureDelete(TWITCH_TOKEN_KEY);
  } catch (error) {
    console.error("TwitchService: Error clearing token:", error);
  }
};

const doRefresh = async (): Promise<TokenResult> => {
  const info = await getTwitchTokenInfo();
  if (!info?.refresh_token) return { status: 'signed_out' };
  if (!isTauriAvailable()) {
    return { status: 'unavailable', reason: 'Token refresh requires the StreamTTS desktop app' };
  }

  const generation = sessionGeneration;
  try {
    const data = await invoke<RefreshedTokens>('twitch_refresh_token', {
      refreshToken: info.refresh_token,
    });
    if (generation !== sessionGeneration) return { status: 'signed_out' };
    // Twitch refresh tokens are single-use: always keep the new one.
    await saveTwitchTokens(
      data.access_token,
      data.refresh_token ?? info.refresh_token,
      data.expires_in ?? undefined,
    );
    return { status: 'ok', token: data.access_token };
  } catch (error) {
    if (isSignedOutError(error)) {
      if (generation === sessionGeneration) await clearTwitchOAuthToken();
      return { status: 'signed_out' };
    }
    return { status: 'unavailable', reason: errorMessage(error) };
  }
};

/**
 * Refreshes the access token. Concurrent callers share one request: a second
 * refresh with the same single-use refresh token would be rejected and sign
 * the user out.
 */
export const refreshTwitchToken = (): Promise<TokenResult> => {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
};

/** A usable access token, refreshed first when it is at or near expiry. */
export const getValidTwitchToken = async (): Promise<TokenResult> => {
  const info = await getTwitchTokenInfo();
  if (!info?.token) return { status: 'signed_out' };
  if (!info.expires_at || Date.now() < info.expires_at - TOKEN_EXPIRY_BUFFER_MS) {
    return { status: 'ok', token: info.token };
  }

  const refreshed = await refreshTwitchToken();
  if (refreshed.status !== 'unavailable') return refreshed;
  // Refresh failed for now (offline?); the current token works until it expires.
  return Date.now() < info.expires_at ? { status: 'ok', token: info.token } : refreshed;
};

type Validation =
  | { status: 'valid'; identity: TwitchIdentity }
  | { status: 'invalid' }
  | { status: 'unreachable' };

const validateAccessToken = async (token: string): Promise<Validation> => {
  try {
    const response = await fetchJson(VALIDATE_URL, { headers: { Authorization: `OAuth ${token}` } }, { timeoutMs: 10_000 });
    if (response.status === 401) return { status: 'invalid' };
    if (!response.ok) return { status: 'unreachable' };
    const body = response.body as { login?: string; user_id?: string; client_id?: string; scopes?: string[] };
    if (!body?.login || !body.user_id || !body.client_id) return { status: 'unreachable' };
    return {
      status: 'valid',
      identity: { login: body.login, userId: body.user_id, clientId: body.client_id, scopes: body.scopes ?? [] },
    };
  } catch {
    return { status: 'unreachable' };
  }
};

/**
 * Validates the stored session, refreshing once if Twitch rejects the access
 * token. Twitch requires apps to validate tokens at startup and hourly. Only
 * a definitive rejection signs the user out; network trouble does not.
 */
export const checkTwitchSession = async (): Promise<SessionCheck> => {
  const current = await getValidTwitchToken();
  if (current.status === 'signed_out') return { status: 'signed_out' };
  if (current.status === 'unavailable') return { status: 'unreachable' };

  let token = current.token;
  let result = await validateAccessToken(token);
  if (result.status === 'invalid') {
    const refreshed = await refreshTwitchToken();
    if (refreshed.status === 'unavailable') return { status: 'unreachable' };
    if (refreshed.status === 'signed_out') {
      await clearTwitchOAuthToken();
      return { status: 'signed_out' };
    }
    token = refreshed.token;
    result = await validateAccessToken(token);
    if (result.status === 'invalid') {
      await clearTwitchOAuthToken();
      return { status: 'signed_out' };
    }
  }
  if (result.status === 'unreachable') return { status: 'unreachable' };

  cachedIdentity = { token, identity: result.identity };
  return result;
};

/** The logged-in user, from the last validation when the token hasn't changed. */
export const getTwitchIdentity = async (): Promise<SessionCheck> => {
  const current = await getValidTwitchToken();
  if (current.status === 'ok' && cachedIdentity?.token === current.token) {
    return { status: 'valid', identity: cachedIdentity.identity };
  }
  return checkTwitchSession();
};

const isValidChannelName = (name: string): boolean => {
  if (!name || typeof name !== 'string') return false;
  return /^[a-zA-Z0-9_]{2,25}$/.test(name);
};

class TwitchConnectionManager {
  private clients = new Map<string, Client>();
  private recentErrors = new Map<string, { message: string; timestamp: number }>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly ERROR_TTL_MS = 30000;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanupOldErrors(), 60000);
  }

  private cleanupOldErrors(): void {
    const now = Date.now();
    for (const [key, entry] of this.recentErrors) {
      if (now - entry.timestamp > this.ERROR_TTL_MS) {
        this.recentErrors.delete(key);
      }
    }
  }

  private shouldReportError(channelName: string, errorMessage: string): boolean {
    const now = Date.now();
    const errorKey = `${channelName}:${errorMessage}`;
    const recent = this.recentErrors.get(errorKey);
    if (recent && now - recent.timestamp < 10000) return false;
    this.recentErrors.set(errorKey, { message: errorMessage, timestamp: now });
    return true;
  }

  async connect(
    channelName: string,
    onMessageReceived: MessageCallback,
    onConnectionChanged: ConnectionCallback
  ): Promise<void> {
    if (!isValidChannelName(channelName)) {
      onConnectionChanged(false, 'Invalid channel name. Use 2-25 alphanumeric characters or underscores.');
      return;
    }

    const existing = this.clients.get(channelName);
    if (existing) {
      existing.disconnect();
      this.clients.delete(channelName);
    }

    try {
      const result = await getValidTwitchToken();
      if (result.status !== 'ok') {
        onConnectionChanged(false, result.status === 'signed_out'
          ? 'Not logged in to Twitch. Log in again.'
          : result.reason);
        return;
      }
      const token = result.token;

      const client = new Client({
        options: { debug: false },
        connection: { secure: true, reconnect: false, timeout: 30000 },
        identity: { username: channelName, password: `oauth:${token}` },
        channels: [channelName]
      });

      client.on('message', (_channel, tags, message, self) => {
        if (self) return;
        const username = tags['display-name'] || tags.username || 'Anonymous';
        onMessageReceived(username, message);
      });

      client.on('connected', () => onConnectionChanged(true));

      client.on('disconnected', (reason) => {
        if (this.shouldReportError(channelName, `disconnect:${reason}`)) {
          onConnectionChanged(false, reason);
        }
        this.clients.delete(channelName);
      });

      client.on('error', (error) => {
        console.error(`Twitch client error for ${channelName}:`, error);
        if (error.message && !error.message.includes('ping timeout')) {
          if (this.shouldReportError(channelName, `error:${error.message}`)) {
            onConnectionChanged(false, error.message);
          }
        }
        if (!error.message || !error.message.includes('ping timeout')) {
          this.clients.delete(channelName);
        }
      });

      client.connect()
        .then(() => this.clients.set(channelName, client))
        .catch(error => {
          console.error('Failed to connect to Twitch:', error);
          if (this.shouldReportError(channelName, `connect:${error.message}`)) {
            onConnectionChanged(false, error.message);
          }
          this.clients.delete(channelName);
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (this.shouldReportError(channelName, `setup:${message}`)) {
        onConnectionChanged(false, message);
        console.error('Error setting up Twitch client:', error);
      }
    }
  }

  disconnect(channelName?: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        if (channelName) {
          const client = this.clients.get(channelName);
          if (!client) { resolve(); return; }

          const timeout = setTimeout(() => {
            console.warn(`Twitch disconnect timeout for ${channelName}, forcing cleanup`);
            this.clients.delete(channelName);
            resolve();
          }, 3000);

          const cleanup = () => {
            clearTimeout(timeout);
            this.clients.delete(channelName);
            resolve();
          };

          client.removeAllListeners('disconnected');
          client.removeAllListeners('error');
          client.once('disconnected', cleanup);
          client.once('error', (err: unknown) => {
            console.error(`Error during Twitch disconnect for ${channelName}:`, err);
            cleanup();
          });

          if (typeof client.disconnect === 'function') {
            client.disconnect().catch((err) => {
              clearTimeout(timeout);
              this.clients.delete(channelName);
              console.error(`Disconnect promise rejected for ${channelName}:`, err);
              resolve();
            });
          } else {
            clearTimeout(timeout);
            this.clients.delete(channelName);
            resolve();
          }
        } else {
          const channels = Array.from(this.clients.keys());
          if (channels.length === 0) { resolve(); return; }
          Promise.allSettled(channels.map(ch => this.disconnect(ch).catch(() => {})))
            .then(() => resolve());
        }
      } catch (error) {
        console.error('Error in disconnect:', error);
        if (channelName) this.clients.delete(channelName);
        resolve();
      }
    });
  }
}

const connectionManager = new TwitchConnectionManager();

export const connectToTwitchChat = async (
  channelName: string,
  onMessageReceived: MessageCallback,
  onConnectionChanged: ConnectionCallback
): Promise<void> => {
  await connectionManager.connect(channelName, onMessageReceived, onConnectionChanged);
};

export const disconnectFromTwitchChat = (channelName?: string): Promise<void> => {
  return connectionManager.disconnect(channelName);
};
