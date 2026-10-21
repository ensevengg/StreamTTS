import { describe, it, expect, beforeEach, vi } from 'vitest';
import { commandHandlers, desktopTauriApi, keychain, resetDesktop } from '@/test/desktopMock';

vi.mock('@/lib/tauri-api', () => desktopTauriApi());

import { fetchActiveBroadcasts, getValidYoutubeToken, saveYoutubeTokens } from './youtubeService';

const KEY = 'youtube_oauth_tokens';
const tokens = (msLeft: number) => ({ access_token: 'ya29.old', refresh_token: '1//r', expires_at: Date.now() + msLeft });

describe('youtubeService tokens', () => {
  beforeEach(() => {
    resetDesktop();
    vi.unstubAllGlobals();
  });

  it('refreshes near expiry, once for concurrent callers', async () => {
    await saveYoutubeTokens(tokens(60_000));
    const refresh = vi.fn(async () => ({ access_token: 'ya29.new', expires_in: 3599 }));
    commandHandlers.set('youtube_refresh_token', refresh);

    const [a, b] = await Promise.all([getValidYoutubeToken(), getValidYoutubeToken()]);
    expect(a).toEqual({ status: 'ok', token: 'ya29.new' });
    expect(b).toEqual({ status: 'ok', token: 'ya29.new' });
    expect(refresh).toHaveBeenCalledTimes(1);
    // Google omits the refresh token on refresh; the old one is kept.
    expect(JSON.parse(keychain.get(KEY)!).refresh_token).toBe('1//r');
  });

  it('signs out on invalid_grant but not on network failure', async () => {
    await saveYoutubeTokens(tokens(-1));
    commandHandlers.set('youtube_refresh_token', () => {
      throw { kind: 'network', message: 'offline' };
    });
    expect((await getValidYoutubeToken()).status).toBe('unavailable');
    expect(keychain.has(KEY)).toBe(true);

    commandHandlers.set('youtube_refresh_token', () => {
      throw { kind: 'invalid_grant', message: 'Token has been expired or revoked.' };
    });
    expect(await getValidYoutubeToken()).toEqual({ status: 'signed_out' });
    expect(keychain.has(KEY)).toBe(false);
  });
});

describe('youtubeService API', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('asks for every broadcast type, so "Stream now" streams are found', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ items: [{ id: 'b1' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await fetchActiveBroadcasts('token')).toEqual([{ id: 'b1' }]);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get('broadcastType')).toBe('all');
    expect(url.searchParams.get('broadcastStatus')).toBe('active');
  });
});
