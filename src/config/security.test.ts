import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TTS_COMMAND_PREFIX, generateOAuthState, validateOAuthState } from './security';

const sessionStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();
Object.defineProperty(globalThis, 'sessionStorage', { value: sessionStorageMock });

describe('TTS_COMMAND_PREFIX', () => {
  it('should be the Russian g prefix', () => {
    expect(TTS_COMMAND_PREFIX).toBe('!г');
  });
});

describe('generateOAuthState / validateOAuthState', () => {
  beforeEach(() => {
    sessionStorageMock.clear();
    vi.clearAllMocks();
  });

  it('round-trips a valid state', () => {
    const state = generateOAuthState('twitch');
    expect(validateOAuthState(state)).toBe(true);
  });

  it('rejects null state', () => {
    expect(validateOAuthState(null)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateOAuthState('')).toBe(false);
  });

  it('rejects malformed state (wrong format)', () => {
    expect(validateOAuthState('not-a-valid-state')).toBe(false);
  });

  it('rejects state with tampered nonce', () => {
    const state = generateOAuthState('twitch');
    const tampered = state.replace(/^[^_]+_auth_([^_]+)/, (_m, nonce) =>
      `twitch_auth_${nonce.replace(/./g, 'x')}`
    );
    expect(validateOAuthState(tampered)).toBe(false);
  });

  it('rejects state with no nonce part', () => {
    expect(validateOAuthState('twitch_auth')).toBe(false);
  });

  it('generates different nonces on each call', () => {
    const a = generateOAuthState('twitch');
    const b = generateOAuthState('twitch');
    expect(a).not.toBe(b);
  });

  it('rejects already-validated state (single-use)', () => {
    const state = generateOAuthState('twitch');
    expect(validateOAuthState(state)).toBe(true);
    expect(validateOAuthState(state)).toBe(false);
  });
});
