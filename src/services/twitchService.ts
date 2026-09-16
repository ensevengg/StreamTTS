import { Client } from 'tmi.js';
import { invoke } from '@tauri-apps/api/core';
import { TWITCH_CLIENT_ID } from '@/config/security';
import { secureGet, secureSet, secureDelete } from '@/lib/secureStorage';
import { isTauriAvailable } from '@/lib/tauri-api';

type MessageCallback = (username: string, message: string) => void;
type ConnectionCallback = (connected: boolean, error?: string) => void;

// Stored in the OS keychain (localStorage only outside the desktop app).
const TWITCH_TOKEN_KEY = 'twitch_oauth_token';
const TOKEN_EXPIRY_BUFFER_MS = 10 * 60 * 1000;

interface TwitchTokenInfo {
  token: string;
  /** Present for authorization-code tokens; implicit tokens had none. */
  refresh_token?: string;
  /** Epoch ms when the access token expires, if known. */
  expires_at?: number;
  timestamp: number;
}

interface TokenCommandResponse {
  access_token: string;
  refresh_token?: string | null;
  expires_in: number;
}

export const saveTwitchOAuthToken = async (
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

export const getTwitchTokenInfo = async (): Promise<TwitchTokenInfo | null> => {
  try {
    const stored = await secureGet(TWITCH_TOKEN_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (typeof parsed === 'string') return { token: parsed, timestamp: 0 };
    return parsed as TwitchTokenInfo;
  } catch (error) {
    console.error("TwitchService: Error reading token info:", error);
    return null;
  }
};

export const getTwitchOAuthToken = async (): Promise<string | null> => {
  return (await getTwitchTokenInfo())?.token || null;
};

const isTokenExpiring = (info: TwitchTokenInfo): boolean => {
  if (!info.expires_at) return false;
  return Date.now() >= info.expires_at - TOKEN_EXPIRY_BUFFER_MS;
};

/**
 * True when the token is missing or at/near expiry. Without a known expiry
 * (legacy implicit tokens) it can only be judged by Helix validation.
 */
export const isTwitchTokenStale = async (): Promise<boolean> => {
  const info = await getTwitchTokenInfo();
  if (!info?.token) return true;
  return isTokenExpiring(info);
};

export const getTokenAgeMinutes = async (): Promise<number | null> => {
  const info = await getTwitchTokenInfo();
  if (!info || info.timestamp === 0) return null;
  return Math.floor((Date.now() - info.timestamp) / (60 * 1000));
};

export const clearTwitchOAuthToken = async (): Promise<void> => {
  try {
    await secureDelete(TWITCH_TOKEN_KEY);
  } catch (error) {
    console.error("TwitchService: Error clearing token:", error);
  }
};

export const hasTwitchOAuthToken = async (): Promise<boolean> => {
  try {
    return !!(await getTwitchTokenInfo())?.token;
  } catch {
    return false;
  }
};

/**
 * Refreshes the Twitch access token via the Rust backend. Returns the new
 * token, or null when there is no refresh token, the desktop shell is
 * missing, or the refresh grant was rejected.
 */
export const refreshTwitchToken = async (): Promise<string | null> => {
  const info = await getTwitchTokenInfo();
  if (!info?.refresh_token) {
    return null;
  }
  if (!isTauriAvailable()) {
    console.warn("TwitchService: Token refresh requires the StreamTTS desktop app");
    return null;
  }

  try {
    const data: TokenCommandResponse = await invoke('twitch_refresh_token', {
      refreshToken: info.refresh_token,
    });
    await saveTwitchOAuthToken(
      data.access_token,
      data.refresh_token || info.refresh_token,
      data.expires_in,
    );
    console.log("TwitchService: Token refreshed successfully");
    return data.access_token;
  } catch (error) {
    const err = error as { kind?: string };
    console.error("TwitchService: Token refresh failed", err);
    if (err?.kind === 'invalid_grant' || err?.kind === 'invalid_client') {
      console.log("TwitchService: Refresh token is invalid, clearing tokens");
      await clearTwitchOAuthToken();
    }
    return null;
  }
};

/**
 * Returns a usable access token, refreshing first when the stored one is at
 * or near expiry. Null means the user must re-authenticate.
 */
const getValidTwitchToken = async (): Promise<string | null> => {
  const info = await getTwitchTokenInfo();
  if (!info?.token) return null;

  if (isTokenExpiring(info)) {
    const refreshed = await refreshTwitchToken();
    if (refreshed) return refreshed;
    // Known-expired and refresh failed: force re-authentication.
    if (info.expires_at && Date.now() >= info.expires_at) return null;
  }

  return info.token;
};

export const validateTwitchToken = async (): Promise<{ valid: boolean; username?: string; error?: string }> => {
  try {
    const token = await getTwitchOAuthToken();
    if (!token) return { valid: false, error: 'No token stored' };

    const response = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
    });

    if (response.status === 401) return { valid: false, error: 'Token expired or revoked' };
    if (!response.ok) return { valid: false, error: `Validation failed: ${response.status}` };

    const data = await response.json();
    if (data?.data?.length > 0) return { valid: true, username: data.data[0].login };

    return { valid: false, error: 'Unexpected response from Twitch' };
  } catch (error) {
    console.error("TwitchService: Error validating token:", error);
    return { valid: false, error: 'Network error during validation' };
  }
};

export const getTwitchUsername = async (): Promise<string | null> => {
  try {
    const token = await getValidTwitchToken();
    if (!token) return null;

    const response = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': TWITCH_CLIENT_ID }
    });

    if (!response.ok) return null;

    const data = await response.json();
    return data?.data?.[0]?.login || null;
  } catch (error) {
    console.error("TwitchService: Error getting username:", error);
    return null;
  }
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
      const token = await getValidTwitchToken();
      if (!token) {
        onConnectionChanged(false, 'Not authenticated with Twitch. Please connect using OAuth.');
        return;
      }

      const client = new Client({
        options: { debug: false, clientId: TWITCH_CLIENT_ID },
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

  disconnectAll(): Promise<void> {
    return this.disconnect();
  }

  isConnected(channelName?: string): boolean {
    if (channelName) return this.clients.has(channelName);
    return this.clients.size > 0;
  }

  getConnectedChannels(): string[] {
    return Array.from(this.clients.keys());
  }

  dispose(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clients.clear();
    this.recentErrors.clear();
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
