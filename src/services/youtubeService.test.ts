import { describe, it, expect, beforeEach, vi } from 'vitest';
import { commandHandlers, desktopTauriApi, keychain, resetDesktop } from '@/test/desktopMock';

vi.mock('@/lib/tauri-api', () => desktopTauriApi());

import {
  clearYoutubeOAuthToken,
  getValidYoutubeToken,
  hasYoutubeOAuthToken,
  invalidateYoutubeAccessToken,
  saveYoutubeTokens,
} from './youtubeService';

const KEY = 'youtube_oauth_tokens';
const tokens = (msLeft: number) => ({ access_token: 'ya29.old', refresh_token: '1//r', expires_at: Date.now() + msLeft });

describe('youtubeService tokens', () => {
  beforeEach(() => {
    resetDesktop();
    vi.unstubAllGlobals();
  });

  it('round-trips and clears tokens', async () => {
    await saveYoutubeTokens(tokens(3_600_000));
    expect(await hasYoutubeOAuthToken()).toBe(true);
    await clearYoutubeOAuthToken();
    expect(await hasYoutubeOAuthToken()).toBe(false);
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

  it('invalidating the access token forces the next read to refresh', async () => {
    await saveYoutubeTokens(tokens(3_600_000));
    await invalidateYoutubeAccessToken();
    commandHandlers.set('youtube_refresh_token', async () => ({ access_token: 'ya29.new', expires_in: 3599 }));
    expect(await getValidYoutubeToken()).toEqual({ status: 'ok', token: 'ya29.new' });
  });
});
