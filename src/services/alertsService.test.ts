import { describe, it, expect, beforeEach, vi } from 'vitest';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

Object.defineProperty(globalThis, 'window', {
  value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
});

if (typeof globalThis.speechSynthesis === 'undefined') {
  Object.defineProperty(globalThis, 'speechSynthesis', {
    value: { getVoices: vi.fn(() => []), speak: vi.fn() },
    writable: true,
  });
}

import { AlertService } from './alertsService';

const DEFAULTS = {
  enabled: true, twitchSubs: true, twitchGifts: true,
  twitchRedemptions: true, youtubeLive: true, volume: 0.8,
};

describe('AlertService', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
    AlertService.getInstance().updateSettings(DEFAULTS);
  });

  describe('singleton', () => {
    it('getInstance returns the same instance', () => {
      expect(AlertService.getInstance()).toBe(AlertService.getInstance());
    });
  });

  describe('settings defaults', () => {
    it('returns default settings when nothing stored', () => {
      const s = AlertService.getInstance().getSettings();
      expect(s.enabled).toBe(true);
      expect(s.volume).toBe(0.8);
      expect(s.twitchSubs).toBe(true);
    });
  });

  describe('settings save/load roundtrip', () => {
    it('persists settings changes across re-initialization', () => {
      AlertService.getInstance().updateSettings({ enabled: false, volume: 0.5 });
      const s = AlertService.getInstance().getSettings();
      expect(s.enabled).toBe(false);
      expect(s.volume).toBe(0.5);
    });

    it('merges partial updates', () => {
      AlertService.getInstance().updateSettings({ volume: 0.3 });
      const s = AlertService.getInstance().getSettings();
      expect(s.volume).toBe(0.3);
      expect(s.enabled).toBe(true);
    });
  });

  describe('alert filtering', () => {
    it('getSettings reflects disabled state', () => {
      AlertService.getInstance().updateSettings({ enabled: false });
      expect(AlertService.getInstance().getSettings().enabled).toBe(false);
    });

    it('getSettings reflects alert type toggles', () => {
      AlertService.getInstance().updateSettings({ twitchSubs: false, twitchGifts: true, youtubeLive: false });
      const s = AlertService.getInstance().getSettings();
      expect(s.twitchSubs).toBe(false);
      expect(s.twitchGifts).toBe(true);
      expect(s.youtubeLive).toBe(false);
    });
  });

  describe('listener management', () => {
    it('addAlertListener and removeListener do not throw', () => {
      const svc = AlertService.getInstance();
      const fn = vi.fn();
      svc.addAlertListener(fn);
      svc.removeAlertListener(fn);
      svc.removeAlertListener(vi.fn());
    });
  });
});
