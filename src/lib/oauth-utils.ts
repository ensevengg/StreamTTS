import { invoke } from '@tauri-apps/api/core';
import { TWITCH_CLIENT_ID, YOUTUBE_CLIENT_ID, generateOAuthState, generatePkcePair } from '@/config/security';
import { isTauriAvailable } from '@/lib/tauri-api';

export interface AuthUrlWithState {
  url: string;
  state: string;
  /** PKCE verifier; present for authorization-code flows. Registered with the
   *  Rust backend via `oauth_begin` — never sent through the browser. */
  codeVerifier?: string;
}

// The Rust backend owns the loopback callback address; the webview must never
// hardcode it. Cached after the first successful fetch.
let redirectUriPromise: Promise<string> | null = null;

function getOAuthRedirectUri(): Promise<string> {
  if (!redirectUriPromise) {
    const fallback = 'http://localhost:3000/callback';
    redirectUriPromise = isTauriAvailable()
      ? invoke<string>('oauth_redirect_uri').catch((error) => {
          console.error('Failed to read redirect URI from backend, using default:', error);
          return fallback;
        })
      : Promise.resolve(fallback);
  }
  return redirectUriPromise;
}

/**
 * Twitch now uses the authorization-code flow with PKCE. The deprecated
 * implicit flow put the token in the URL fragment and could not be refreshed.
 */
export async function buildTwitchAuthUrl(): Promise<AuthUrlWithState> {
  const state = generateOAuthState('twitch');
  const { verifier, challenge } = await generatePkcePair();
  const redirectUri = await getOAuthRedirectUri();

  const scopes = ['chat:read'];
  const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
  authUrl.searchParams.append('client_id', TWITCH_CLIENT_ID);
  authUrl.searchParams.append('redirect_uri', redirectUri);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('scope', scopes.join(' '));
  authUrl.searchParams.append('force_verify', 'true');
  authUrl.searchParams.append('code_challenge', challenge);
  authUrl.searchParams.append('code_challenge_method', 'S256');
  authUrl.searchParams.append('state', state);
  return { url: authUrl.toString(), state, codeVerifier: verifier };
}

/**
 * YouTube authorization-code flow with PKCE. Scopes are limited to what the
 * app actually needs: read-only channel/broadcast data and live-chat reads.
 */
export async function buildYouTubeAuthUrl(): Promise<AuthUrlWithState> {
  const state = generateOAuthState('youtube');
  const { verifier, challenge } = await generatePkcePair();
  const redirectUri = await getOAuthRedirectUri();

  const scopes = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl',
  ];
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.append('client_id', YOUTUBE_CLIENT_ID);
  authUrl.searchParams.append('redirect_uri', redirectUri);
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('access_type', 'offline');
  authUrl.searchParams.append('scope', scopes.join(' '));
  authUrl.searchParams.append('prompt', 'consent');
  authUrl.searchParams.append('include_granted_scopes', 'true');
  authUrl.searchParams.append('code_challenge', challenge);
  authUrl.searchParams.append('code_challenge_method', 'S256');
  authUrl.searchParams.append('state', state);
  return { url: authUrl.toString(), state, codeVerifier: verifier };
}

/**
 * Registers the OAuth state (and PKCE verifier, if any) with the Rust backend
 * so the loopback callback server can consume it exactly once. Must be
 * awaited before the provider flow starts; a no-op outside Tauri.
 */
export async function prepareOAuthState(
  service: 'twitch' | 'youtube',
  state: string,
  codeVerifier?: string,
): Promise<void> {
  if (!isTauriAvailable()) return;
  await invoke('oauth_begin', { service, state, codeVerifier });
}
