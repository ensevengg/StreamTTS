import { invoke, isTauriAvailable, openExternal, requireDesktop, type AuthCallbackData } from '@/lib/tauri-api';
import { saveTwitchTokens } from '@/services/twitchService';
import { saveYoutubeTokens } from '@/services/youtubeService';

export interface TwitchDeviceCode {
  user_code: string;
  verification_uri: string;
  expires_in: number;
}

/**
 * Starts Twitch's device-code login and opens the approval page. The result
 * arrives later as an `auth-callback` event (see useAuthCallbacks).
 */
export async function startTwitchLogin(): Promise<TwitchDeviceCode> {
  requireDesktop();
  const code = await invoke<TwitchDeviceCode>('twitch_device_start');
  try {
    await openExternal(code.verification_uri);
  } catch (error) {
    // The UI still shows the code and a link to open the page manually.
    console.error('Could not open the Twitch activation page:', error);
  }
  return code;
}

export async function cancelTwitchLogin(): Promise<void> {
  if (isTauriAvailable()) await invoke('twitch_device_cancel');
}

/** Opens Google's consent page; the backend finishes the login on redirect. */
export async function startYoutubeLogin(): Promise<void> {
  requireDesktop();
  const url = await invoke<string>('youtube_auth_start');
  await openExternal(url);
}

export interface LoginResult {
  ok: boolean;
  error?: string;
}

/** Stores the tokens from a finished login. */
export async function completeLogin(data: AuthCallbackData): Promise<LoginResult> {
  if (!data.access_token) {
    return { ok: false, error: data.error || 'The login did not complete.' };
  }
  if (data.service === 'twitch') {
    await saveTwitchTokens(data.access_token, data.refresh_token ?? undefined, data.expires_in ?? undefined);
    return { ok: true };
  }
  if (!data.refresh_token) {
    // Without one, chat would stop working when the 1-hour access token expires.
    return { ok: false, error: 'Google did not return a refresh token. Please try logging in again.' };
  }
  await saveYoutubeTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  });
  return { ok: true };
}
