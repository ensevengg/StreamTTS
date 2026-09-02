import { invoke } from '@tauri-apps/api/core';
import { isTauriAvailable } from '@/lib/tauri-api';

/**
 * Credential storage backed by the OS keychain (Windows Credential Manager,
 * macOS Keychain, Linux secret-service) through the Rust `secret_*` commands.
 *
 * Outside the Tauri shell (plain-web dev mode) it falls back to localStorage;
 * the packaged desktop app never uses that path.
 */

export type SecureKey = 'twitch_oauth_token' | 'youtube_oauth_tokens' | 'streamtts-settings';

const ALLOWED_KEYS: SecureKey[] = ['twitch_oauth_token', 'youtube_oauth_tokens', 'streamtts-settings'];

const isSecureKey = (key: string): key is SecureKey =>
  ALLOWED_KEYS.includes(key as SecureKey);

// globalThis.localStorage works in the browser and in node-based tests alike
// (window itself is undefined outside a browser context).
const fallbackStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export const secureGet = async (key: SecureKey): Promise<string | null> => {
  if (!isTauriAvailable()) {
    return fallbackStorage()?.getItem(key) ?? null;
  }
  try {
    return await invoke<string | null>('secret_get', { key });
  } catch (error) {
    console.error(`SecureStorage: failed to read '${key}' from keychain`, error);
    return null;
  }
};

export const secureSet = async (key: SecureKey, value: string): Promise<void> => {
  if (!isTauriAvailable()) {
    fallbackStorage()?.setItem(key, value);
    return;
  }
  await invoke('secret_set', { key, value });
};

export const secureDelete = async (key: SecureKey): Promise<void> => {
  if (!isTauriAvailable()) {
    fallbackStorage()?.removeItem(key);
    return;
  }
  await invoke('secret_delete', { key });
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

/**
 * zustand `persist` adapter so the settings store (which contains the
 * ElevenLabs API key) hydrates from the keychain.
 */
export const secureStateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (!isSecureKey(name)) {
      throw new Error(`SecureStorage: unexpected state key '${name}'`);
    }
    return secureGet(name);
  },
  setItem: async (name: string, value: string): Promise<void> => {
    if (!isSecureKey(name)) {
      throw new Error(`SecureStorage: unexpected state key '${name}'`);
    }
    await secureSet(name, value);
  },
  removeItem: async (name: string): Promise<void> => {
    if (!isSecureKey(name)) {
      throw new Error(`SecureStorage: unexpected state key '${name}'`);
    }
    await secureDelete(name);
  },
};
