import { invoke, isTauriAvailable } from '@/lib/tauri-api';

/**
 * Credential storage backed by the OS keychain (Windows Credential Manager,
 * macOS Keychain, Linux secret-service) through the Rust `secret_*` commands.
 *
 * Outside the Tauri shell (plain-web dev mode, tests) it falls back to
 * localStorage; the packaged desktop app never uses that path.
 *
 * Values are cached in memory after the first read: tokens are read on every
 * chat poll and API call, and a keychain round-trip per read is slow (and on
 * some platforms can prompt the user).
 */

type SecureKey = 'twitch_oauth_token' | 'youtube_oauth_tokens' | 'streamtts-settings';

const ALLOWED_KEYS: SecureKey[] = ['twitch_oauth_token', 'youtube_oauth_tokens', 'streamtts-settings'];

const isSecureKey = (key: string): key is SecureKey =>
  ALLOWED_KEYS.includes(key as SecureKey);

const cache = new Map<SecureKey, string | null>();

// globalThis.localStorage works in the browser and in node-based tests alike
// (window itself is undefined outside a browser context).
const fallbackStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const readStore = async (key: SecureKey): Promise<string | null> => {
  if (!isTauriAvailable()) {
    return fallbackStorage()?.getItem(key) ?? null;
  }
  return await invoke<string | null>('secret_get', { key });
};

export const secureGet = async (key: SecureKey): Promise<string | null> => {
  if (cache.has(key)) return cache.get(key) ?? null;
  try {
    const value = await readStore(key);
    cache.set(key, value);
    return value;
  } catch (error) {
    // Not cached: a keychain that was locked or briefly unavailable gets
    // another chance on the next read.
    console.error(`SecureStorage: failed to read '${key}' from keychain`, error);
    return null;
  }
};

export const secureSet = async (key: SecureKey, value: string): Promise<void> => {
  if (!isTauriAvailable()) {
    fallbackStorage()?.setItem(key, value);
  } else {
    await invoke('secret_set', { key, value });
  }
  cache.set(key, value);
};

export const secureDelete = async (key: SecureKey): Promise<void> => {
  // Forget the cached copy first so a failed keychain delete still signs the
  // user out of this session.
  cache.set(key, null);
  if (!isTauriAvailable()) {
    fallbackStorage()?.removeItem(key);
    return;
  }
  await invoke('secret_delete', { key });
};

/** Drops the in-memory copies; for tests that rewrite storage directly. */
export const resetSecureStorageCache = (): void => {
  cache.clear();
};

const LEGACY_KEYS: ReadonlyArray<readonly [string, SecureKey]> = [
  ['twitchOAuthToken', 'twitch_oauth_token'],
  ['youtube_oauth_tokens', 'youtube_oauth_tokens'],
  ['streamtts-settings', 'streamtts-settings'],
];

/**
 * One-time move of credentials from plaintext localStorage into the OS
 * keychain. Runs before auth hydration so the UI reflects the migrated state.
 */
export const migrateLegacyCredentials = async (): Promise<void> => {
  if (!isTauriAvailable()) return;

  for (const [legacyKey, secureKey] of LEGACY_KEYS) {
    try {
      const existing = await secureGet(secureKey);
      if (existing) {
        // Already in the keychain; drop any leftover plaintext copy.
        fallbackStorage()?.removeItem(legacyKey);
        continue;
      }
      const legacy = fallbackStorage()?.getItem(legacyKey) ?? null;
      if (legacy) {
        await secureSet(secureKey, legacy);
        fallbackStorage()?.removeItem(legacyKey);
        console.info(`SecureStorage: migrated '${legacyKey}' to the OS keychain`);
      }
    } catch (error) {
      // Keep the plaintext copy on failure so no data is lost; retry next launch.
      console.error(`SecureStorage: migration failed for '${legacyKey}'`, error);
    }
  }
};

const SETTINGS_WRITE_DELAY_MS = 500;
let pendingSettingsWrite: { timer: ReturnType<typeof setTimeout>; value: string } | null = null;

const flushSettingsWrite = (): void => {
  if (!pendingSettingsWrite) return;
  const { timer, value } = pendingSettingsWrite;
  clearTimeout(timer);
  pendingSettingsWrite = null;
  secureSet('streamtts-settings', value).catch((error) => {
    console.error('SecureStorage: failed to save settings', error);
  });
};

if (typeof window !== 'undefined') {
  window.addEventListener?.('beforeunload', flushSettingsWrite);
}

/**
 * zustand `persist` adapter so the settings store (which contains the
 * ElevenLabs API key) hydrates from the keychain. Writes are debounced:
 * persist saves on every state change, and dragging the volume slider would
 * otherwise write to the OS keychain dozens of times a second.
 */
export const secureStateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (!isSecureKey(name)) {
      throw new Error(`SecureStorage: unexpected state key '${name}'`);
    }
    if (name === 'streamtts-settings' && pendingSettingsWrite) {
      return pendingSettingsWrite.value;
    }
    return secureGet(name);
  },
  setItem: async (name: string, value: string): Promise<void> => {
    if (!isSecureKey(name)) {
      throw new Error(`SecureStorage: unexpected state key '${name}'`);
    }
    if (name !== 'streamtts-settings') {
      await secureSet(name, value);
      return;
    }
    if (pendingSettingsWrite) clearTimeout(pendingSettingsWrite.timer);
    pendingSettingsWrite = { value, timer: setTimeout(flushSettingsWrite, SETTINGS_WRITE_DELAY_MS) };
  },
  removeItem: async (name: string): Promise<void> => {
    if (!isSecureKey(name)) {
      throw new Error(`SecureStorage: unexpected state key '${name}'`);
    }
    if (name === 'streamtts-settings' && pendingSettingsWrite) {
      clearTimeout(pendingSettingsWrite.timer);
      pendingSettingsWrite = null;
    }
    await secureDelete(name);
  },
};
