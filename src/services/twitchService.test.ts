import { describe, it, expect, beforeEach, vi } from 'vitest';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

import {
  saveTwitchOAuthToken,
  getTwitchOAuthToken,
  hasTwitchOAuthToken,
  clearTwitchOAuthToken,
  isTwitchTokenStale,
  getTokenAgeMinutes,
  refreshTwitchToken,
} from './twitchService';

// Outside Tauri the service stores under this key in localStorage.
const TOKEN_KEY = 'twitch_oauth_token';

describe('twitchService token management', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('round-trips a token', async () => {
    await saveTwitchOAuthToken('abc123');
    expect(await getTwitchOAuthToken()).toBe('abc123');
    expect(await hasTwitchOAuthToken()).toBe(true);
  });

  it('stores refresh token and expiry when provided', async () => {
    await saveTwitchOAuthToken('abc123', 'def456', 3600);
    const raw = JSON.parse(localStorageMock.getItem(TOKEN_KEY) ?? '{}');
    expect(raw.token).toBe('abc123');
    expect(raw.refresh_token).toBe('def456');
    expect(raw.expires_at).toBeGreaterThan(Date.now());
  });

  it('clears a token', async () => {
    await saveTwitchOAuthToken('abc123');
    await clearTwitchOAuthToken();
    expect(await getTwitchOAuthToken()).toBeNull();
    expect(await hasTwitchOAuthToken()).toBe(false);
  });

  it('returns null when no token stored', async () => {
    expect(await getTwitchOAuthToken()).toBeNull();
    expect(await hasTwitchOAuthToken()).toBe(false);
  });

  it('isTwitchTokenStale returns true when no token', async () => {
    expect(await isTwitchTokenStale()).toBe(true);
  });

  it('isTwitchTokenStale returns false for token without known expiry', async () => {
    await saveTwitchOAuthToken('fresh-token');
    expect(await isTwitchTokenStale()).toBe(false);
  });

  it('isTwitchTokenStale returns true when token expires within the buffer', async () => {
    const expiring = {
      token: 'soon',
      timestamp: Date.now(),
      expires_at: Date.now() + 5 * 60 * 1000,
    };
    localStorageMock.setItem(TOKEN_KEY, JSON.stringify(expiring));
    expect(await isTwitchTokenStale()).toBe(true);
  });

  it('isTwitchTokenStale returns false for token with distant expiry', async () => {
    const valid = {
      token: 'long-lived',
      timestamp: Date.now(),
      expires_at: Date.now() + 3600 * 1000,
    };
    localStorageMock.setItem(TOKEN_KEY, JSON.stringify(valid));
    expect(await isTwitchTokenStale()).toBe(false);
  });

  it('getTokenAgeMinutes returns null when no token', async () => {
    expect(await getTokenAgeMinutes()).toBeNull();
  });

  it('getTokenAgeMinutes returns a number for fresh token', async () => {
    await saveTwitchOAuthToken('token');
    const age = await getTokenAgeMinutes();
    expect(age).toBeTypeOf('number');
    expect(age).toBeGreaterThanOrEqual(0);
  });

  it('handles legacy string-only token format', async () => {
    localStorageMock.setItem(TOKEN_KEY, JSON.stringify('legacy-token'));
    expect(await getTwitchOAuthToken()).toBe('legacy-token');
    expect(await hasTwitchOAuthToken()).toBe(true);
  });

  it('survives corrupted storage gracefully', async () => {
    localStorageMock.setItem(TOKEN_KEY, '{bad json');
    expect(await getTwitchOAuthToken()).toBeNull();
    expect(await hasTwitchOAuthToken()).toBe(false);
  });

  it('refreshTwitchToken returns null without a refresh token', async () => {
    await saveTwitchOAuthToken('abc123');
    expect(await refreshTwitchToken()).toBeNull();
    expect(await hasTwitchOAuthToken()).toBe(true);
  });
});
