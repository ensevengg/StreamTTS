// Centralized configuration for StreamTTS
// Client IDs must be provided via environment variables

export const TTS_COMMAND_PREFIX = '!г';

const TWITCH_CLIENT_ID_ENV = import.meta.env.VITE_TWITCH_CLIENT_ID;
const YOUTUBE_CLIENT_ID_ENV = import.meta.env.VITE_YOUTUBE_CLIENT_ID;

// The OAuth redirect URI is owned by the Rust backend and exposed to the
// webview via the `oauth_redirect_uri` command (see src/lib/oauth-utils.ts)
// so the callback address lives in exactly one place.

function assertClientId(label: string, value: string): string {
  if (!value) {
    console.error(
      `[StreamTTS] ${label} is not configured. Set VITE_${label} in .env to enable ${label} authentication.`
    );
  }
  return value;
}

export const TWITCH_CLIENT_ID = assertClientId(
  'TWITCH_CLIENT_ID',
  TWITCH_CLIENT_ID_ENV || '',
);
export const YOUTUBE_CLIENT_ID = assertClientId(
  'YOUTUBE_CLIENT_ID',
  YOUTUBE_CLIENT_ID_ENV || '',
);

export const hasTwitchClientId = !!TWITCH_CLIENT_ID;
export const hasYoutubeClientId = !!YOUTUBE_CLIENT_ID;

const STATE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const STATE_KEY = 'oauth_state_storage';

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * PKCE pair for authorization-code flows. The challenge travels in the
 * authorize URL (public by design); the verifier is registered with the Rust
 * backend via `oauth_begin` and never passes through the browser.
 */
export const generatePkcePair = async (): Promise<{ verifier: string; challenge: string }> => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = base64UrlEncode(bytes);

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));

  return { verifier, challenge };
};

interface StoredState {
  nonce: string;
  service: string;
  createdAt: number;
}

export const generateOAuthState = (service: string): string => {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  const nonce = Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  const state: StoredState = {
    nonce,
    service,
    createdAt: Date.now()
  };
  
  const encoded = btoa(JSON.stringify(state));
  const stateWithExpiry = `${service}_auth_${nonce}_${Date.now()}`;
  
  try {
    sessionStorage.setItem(STATE_KEY, encoded);
  } catch (e) {
    console.error('Failed to store OAuth state:', e);
  }
  
  return stateWithExpiry;
};

export const validateOAuthState = (receivedState: string | null): boolean => {
  if (!receivedState) return false;
  
  const parts = receivedState.split('_');
  if (parts.length < 3 || parts[0] === '' || parts[1] !== 'auth') {
    return false;
  }
  
  const receivedNonce = parts[2];
  let receivedTimestamp: number | undefined;
  
  if (parts.length >= 3) {
    const possibleTimestamp = parseInt(parts[3], 10);
    if (!isNaN(possibleTimestamp)) {
      receivedTimestamp = possibleTimestamp;
    }
  }
  
  if (receivedTimestamp && Date.now() - receivedTimestamp > STATE_EXPIRY_MS) {
    sessionStorage.removeItem(STATE_KEY);
    return false;
  }
  
  let storedEncoded: string | null = null;
  try {
    storedEncoded = sessionStorage.getItem(STATE_KEY);
  } catch (e) {
    return false;
  }
  
  if (!storedEncoded) return false;
  
  try {
    const stored: StoredState = JSON.parse(atob(storedEncoded));
    sessionStorage.removeItem(STATE_KEY);
    
    return stored.nonce === receivedNonce && 
           (Date.now() - stored.createdAt) <= STATE_EXPIRY_MS;
  } catch {
    return false;
  }
};

// Sanitize a string for safe display (strip HTML tags, limit length)
export const sanitizeForDisplay = (input: string, maxLength: number = 100): string => {
  if (!input || typeof input !== 'string') return '';
  return input
    .replace(/[<>&"']/g, '') // Strip HTML-significant characters
    .replace(/\0/g, '')      // Strip null bytes
    .slice(0, maxLength)
    .trim();
};

// Validate a username is safe (alphanumeric + underscore, reasonable length)
export const isValidUsername = (name: string): boolean => {
  if (!name || typeof name !== 'string') return false;
  return /^[a-zA-Z0-9_]{1,30}$/.test(name);
};
