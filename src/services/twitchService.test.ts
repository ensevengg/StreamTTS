import { describe, it, expect, beforeEach, vi } from 'vitest';
import { commandHandlers, desktopTauriApi, keychain, resetDesktop } from '@/test/desktopMock';

vi.mock('@/lib/tauri-api', () => desktopTauriApi());

import {
  checkTwitchSession,
  clearTwitchOAuthToken,
  getValidTwitchToken,
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

  it('signs out on invalid_grant but not on network failure', async () => {
    storeExpiring(-1);
    commandHandlers.set('twitch_refresh_token', () => {
      throw { kind: 'network', message: 'offline' };
    });
    expect((await getValidTwitchToken()).status).toBe('unavailable');
    expect(keychain.has(KEY)).toBe(true);

    commandHandlers.set('twitch_refresh_token', () => {
      throw { kind: 'invalid_grant', message: 'Invalid refresh token' };
    });
    expect(await getValidTwitchToken()).toEqual({ status: 'signed_out' });
    expect(keychain.has(KEY)).toBe(false);
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
  });
});
