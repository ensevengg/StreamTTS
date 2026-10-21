import { speakAlert } from '@/services/chatSpeech';

export type AlertType = 'sub' | 'gift' | 'redemption' | 'superchat' | 'member';

export interface AlertData {
  platform: 'twitch' | 'youtube';
  alert_type: AlertType;
  user_name: string;
  /** Spoken and shown. */
  message: string;
  /** Viewer-written text (Super Chat comment, redemption input); shown only. */
  detail?: string;
  count?: number;
}

export interface AlertSettings {
  enabled: boolean;
  twitchSubs: boolean;
  twitchGifts: boolean;
  twitchRedemptions: boolean;
  youtubeSuperChats: boolean;
  youtubeMemberships: boolean;
  volume: number;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: true,
  twitchSubs: true,
  twitchGifts: true,
  twitchRedemptions: true,
  youtubeSuperChats: true,
  youtubeMemberships: true,
  volume: 0.8,
};

const SETTINGS_KEY = 'streamtts-alert-settings';

type Listener = (alert: AlertData) => void;

export class AlertService {
  private static instance: AlertService;
  private settings: AlertSettings;
  private readonly listeners = new Set<Listener>();
  private readonly settingsListeners = new Set<() => void>();

  private constructor() {
    this.settings = this.loadSettings();
  }

  public static getInstance(): AlertService {
    if (!AlertService.instance) {
      AlertService.instance = new AlertService();
    }
    return AlertService.instance;
  }

  /** Speaks and shows an alert, if its type is enabled. */
  public publish(alert: AlertData): void {
    if (!this.isEnabled(alert)) return;
    speakAlert(alert, this.settings.volume);
    this.listeners.forEach(listener => listener(alert));
  }

  /** Whether the Twitch EventSub connection is worth keeping open. */
  public wantsTwitchEvents(): boolean {
    const s = this.settings;
    return s.enabled && (s.twitchSubs || s.twitchGifts || s.twitchRedemptions);
  }

  public getSettings(): AlertSettings {
    return { ...this.settings };
  }

  public updateSettings(newSettings: Partial<AlertSettings>): void {
    this.settings = { ...this.settings, ...newSettings };
    this.saveSettings();
    this.settingsListeners.forEach(listener => listener());
  }

  public onSettingsChange(listener: () => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private isEnabled(alert: AlertData): boolean {
    const s = this.settings;
    if (!s.enabled) return false;
    if (alert.platform === 'twitch') {
      switch (alert.alert_type) {
        case 'sub': return s.twitchSubs;
        case 'gift': return s.twitchGifts;
        case 'redemption': return s.twitchRedemptions;
        default: return false;
      }
    }
    switch (alert.alert_type) {
      case 'superchat': return s.youtubeSuperChats;
      case 'member': return s.youtubeMemberships;
      default: return false;
    }
  }

  private loadSettings(): AlertSettings {
    try {
      const saved = JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) ?? 'null');
      if (saved && typeof saved === 'object') {
        // Keep only known keys, so settings from older versions (which had
        // youtubeLive) merge cleanly over the defaults.
        const merged = { ...DEFAULT_ALERT_SETTINGS };
        for (const key of Object.keys(DEFAULT_ALERT_SETTINGS) as (keyof AlertSettings)[]) {
          if (typeof saved[key] === typeof DEFAULT_ALERT_SETTINGS[key]) {
            (merged as Record<string, unknown>)[key] = saved[key];
          }
        }
        return merged;
      }
    } catch (error) {
      console.error('AlertService: Failed to load settings', error);
    }
    return { ...DEFAULT_ALERT_SETTINGS };
  }

  private saveSettings(): void {
    try {
      globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch (error) {
      console.error('AlertService: Failed to save settings', error);
    }
  }
}
