import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { desktopTauriApi, fakeInvoke, keychain, resetDesktop } from '@/test/desktopMock';

vi.mock('@/lib/tauri-api', () => desktopTauriApi());

import { secureDelete, secureGet, secureSet, secureStateStorage } from './secureStorage';

const keychainCalls = (command: string) => fakeInvoke.mock.calls.filter(([c]) => c === command).length;

describe('secureStorage', () => {
  beforeEach(() => resetDesktop());

  it('reads the keychain once and serves later reads from memory', async () => {
    keychain.set('twitch_oauth_token', 'value');
    expect(await secureGet('twitch_oauth_token')).toBe('value');
    expect(await secureGet('twitch_oauth_token')).toBe('value');
    expect(keychainCalls('secret_get')).toBe(1);
  });

  it('keeps the cache in step with writes and deletes', async () => {
    await secureSet('youtube_oauth_tokens', 'a');
    expect(await secureGet('youtube_oauth_tokens')).toBe('a');
    await secureDelete('youtube_oauth_tokens');
    expect(await secureGet('youtube_oauth_tokens')).toBeNull();
    expect(keychainCalls('secret_get')).toBe(0);
  });

  it('retries a keychain read that failed', async () => {
    fakeInvoke.mockRejectedValueOnce(new Error('keychain locked'));
    expect(await secureGet('twitch_oauth_token')).toBeNull();
    keychain.set('twitch_oauth_token', 'value');
    expect(await secureGet('twitch_oauth_token')).toBe('value');
  });

  describe('settings writes', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('collapses a burst of changes (a slider drag) into one keychain write', async () => {
      for (let volume = 0; volume < 20; volume++) {
        await secureStateStorage.setItem('streamtts-settings', JSON.stringify({ volume }));
      }
      expect(keychainCalls('secret_set')).toBe(0);
      // Reads during the burst see the latest value.
      expect(await secureStateStorage.getItem('streamtts-settings')).toBe(JSON.stringify({ volume: 19 }));

      await vi.advanceTimersByTimeAsync(600);
      expect(keychainCalls('secret_set')).toBe(1);
      expect(keychain.get('streamtts-settings')).toBe(JSON.stringify({ volume: 19 }));
    });

    it('rejects keys outside the allowlist', async () => {
      await expect(secureStateStorage.setItem('other', 'x')).rejects.toThrow();
    });
  });
});
