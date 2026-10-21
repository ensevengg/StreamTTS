import { describe, it, expect, beforeEach, vi } from 'vitest';
import { commandHandlers, desktopTauriApi, fakeInvoke, keychain, resetDesktop } from '@/test/desktopMock';

vi.mock('@/lib/tauri-api', () => desktopTauriApi());

import {
  checkTwitchSession,
  clearTwitchOAuthToken,
  getValidTwitchToken,
  hasTwitchOAuthToken,
  saveTwitchTokens,
} from './twitchService';

const KEY = 'twitch_oauth_token';
const stored = () => JSON.parse(keychain.get(KEY) ?? 'null');

/** Stores a token that is about to expire, so the next read refreshes it. */
const storeExpiring = (msLeft = 60_000) =>
  keychain.set(KEY, JSON.stringify({ token: 'old', refresh_token: 'r1', expires_at: Date.now() + msLeft, timestamp: 0 }));

const validateResponse = (status: number) =>
  new Response(
    status === 200 ? JSON.stringify({ login: 'streamer', user_id: '42', client_id: 'cid', scopes: ['chat:read'] }) : '{}',
    { status },
  );

describe('twitchService', () => {
  beforeEach(() => {
    resetDesktop();
    vi.unstubAllGlobals();
  });

  it('stores tokens in the keychain with their expiry', async () => {
    await saveTwitchTokens('access', 'refresh', 14_400);
    expect(stored()).toMatchObject({ token: 'access', refresh_token: 'refresh' });
    expect(stored().expires_at).toBeGreaterThan(Date.now());
    expect(await hasTwitchOAuthToken()).toBe(true);
  });

  it('returns a fresh token without refreshing', async () => {
    await saveTwitchTokens('access', 'refresh', 14_400);
    expect(await getValidTwitchToken()).toEqual({ status: 'ok', token: 'access' });
    expect(fakeInvoke).not.toHaveBeenCalledWith('twitch_refresh_token', expect.anything());
  });

  it('refreshes once for concurrent callers and keeps the rotated refresh token', async () => {
    storeExpiring();
    const refresh = vi.fn(async () => ({ access_token: 'new', refresh_token: 'r2', expires_in: 14_400 }));
    commandHandlers.set('twitch_refresh_token', refresh);

    const results = await Promise.all([getValidTwitchToken(), getValidTwitchToken(), getValidTwitchToken()]);
    expect(results.every(r => r.status === 'ok' && r.token === 'new')).toBe(true);
    // Twitch refresh tokens are single-use: a second request would fail.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stored().refresh_token).toBe('r2');
  });

  it('signs out when Twitch rejects the refresh token', async () => {
    storeExpiring();
    commandHandlers.set('twitch_refresh_token', () => {
      throw { kind: 'invalid_grant', message: 'Invalid refresh token' };
    });
    expect(await getValidTwitchToken()).toEqual({ status: 'signed_out' });
    expect(keychain.has(KEY)).toBe(false);
  });

  it('keeps using the current token while a refresh fails for network reasons', async () => {
    storeExpiring(60_000);
    commandHandlers.set('twitch_refresh_token', () => {
      throw { kind: 'network', message: 'offline' };
    });
    expect(await getValidTwitchToken()).toEqual({ status: 'ok', token: 'old' });
    expect(keychain.has(KEY)).toBe(true);
  });

  it('reports "unavailable" (not signed out) once that token has expired', async () => {
    storeExpiring(-1);
    commandHandlers.set('twitch_refresh_token', () => {
      throw { kind: 'network', message: 'offline' };
    });
    expect((await getValidTwitchToken()).status).toBe('unavailable');
    expect(keychain.has(KEY)).toBe(true);
  });

  it('a refresh that finishes after logout does not sign the user back in', async () => {
    storeExpiring();
    let finishRefresh: (value: unknown) => void = () => {};
    commandHandlers.set('twitch_refresh_token', () => new Promise(resolve => { finishRefresh = resolve; }));

    const pending = getValidTwitchToken();
    await new Promise(resolve => setTimeout(resolve, 0));
    await clearTwitchOAuthToken();
    finishRefresh({ access_token: 'new', refresh_token: 'r2', expires_in: 14_400 });

    expect(await pending).toEqual({ status: 'signed_out' });
    expect(keychain.has(KEY)).toBe(false);
  });

  describe('checkTwitchSession', () => {
    it('refreshes a rejected token and returns the identity', async () => {
      await saveTwitchTokens('revoked', 'r1', 14_400);
      commandHandlers.set('twitch_refresh_token', async () => ({ access_token: 'new', refresh_token: 'r2', expires_in: 14_400 }));
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(validateResponse(401))
        .mockResolvedValueOnce(validateResponse(200));
      vi.stubGlobal('fetch', fetchMock);

      const result = await checkTwitchSession();
      expect(result).toEqual({
        status: 'valid',
        identity: { login: 'streamer', userId: '42', clientId: 'cid', scopes: ['chat:read'] },
      });
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('OAuth new');
    });

    it('does not sign out when Twitch is unreachable', async () => {
      await saveTwitchTokens('access', 'r1', 14_400);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
      expect(await checkTwitchSession()).toEqual({ status: 'unreachable' });
      expect(keychain.has(KEY)).toBe(true);
    });

    it('signs out when even a refreshed token is rejected', async () => {
      await saveTwitchTokens('revoked', 'r1', 14_400);
      commandHandlers.set('twitch_refresh_token', async () => ({ access_token: 'also-bad', refresh_token: 'r2', expires_in: 14_400 }));
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => validateResponse(401)));
      expect(await checkTwitchSession()).toEqual({ status: 'signed_out' });
      expect(keychain.has(KEY)).toBe(false);
    });
  });
});
