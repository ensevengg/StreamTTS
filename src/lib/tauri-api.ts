import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-shell';

export const isTauriAvailable = (): boolean => {
  // The IPC plumbing object is always injected in a Tauri webview, unlike the
  // optional global API object (withGlobalTauri), which we don't enable.
  return typeof window !== 'undefined' &&
         '__TAURI_INTERNALS__' in window;
};

export type AuthService = 'twitch' | 'youtube';

/** Payload of the backend's `auth-callback` event (see oauth.rs). */
export interface AuthCallbackData {
  service: AuthService;
  access_token?: string | null;
  refresh_token?: string | null;
  expires_in?: number | null;
  error?: string | null;
}

/** Tokens returned by the `*_refresh_token` commands. */
export interface RefreshedTokens {
  access_token: string;
  refresh_token?: string | null;
  expires_in?: number | null;
}

/** Rejection shape of the refresh commands (CommandError in oauth.rs). */
export interface CommandError {
  kind: 'not_configured' | 'network' | 'bad_response' | 'invalid_grant' | 'invalid_client';
  message: string;
}

const isCommandError = (value: unknown): value is CommandError =>
  typeof value === 'object' && value !== null && 'kind' in value;

/** The refresh token is dead; only a new login can fix it. */
export const isSignedOutError = (error: unknown): boolean =>
  isCommandError(error) && (error.kind === 'invalid_grant' || error.kind === 'invalid_client');

export const requireDesktop = (): void => {
  if (!isTauriAvailable()) {
    throw new Error('Logging in requires the StreamTTS desktop app.');
  }
};

export const openExternal = async (url: string): Promise<void> => {
  requireDesktop();
  await open(url);
};

export { invoke };

const subscribe = <T>(event: string, callback: (payload: T) => void): (() => void) => {
  if (!isTauriAvailable()) return () => {};
  const unlisten = listen<T>(event, (e) => callback(e.payload));
  return () => {
    unlisten.then(fn => fn()).catch(console.error);
  };
};

export const onAuthCallback = (callback: (data: AuthCallbackData) => void): (() => void) =>
  subscribe('auth-callback', callback);

export const onOAuthServerError = (callback: (message: string) => void): (() => void) =>
  subscribe('oauth-server-error', callback);
