import { onAlert, type AlertData } from '@/lib/tauri-api';

export type { AlertData };

export interface AlertSettings {
  enabled: boolean;
  twitchSubs: boolean;
  twitchGifts: boolean;
  twitchRedemptions: boolean;
  youtubeLive: boolean;
  volume: number;
}

export class AlertService {
  private static instance: AlertService;
  private settings: AlertSettings;
  private listeners: Array<(alert: AlertData) => void> = [];
  private alertCleanup: (() => void) | null = null;

  private constructor() {
    this.settings = this.loadSettings();
  }

  public static getInstance(): AlertService {
    if (!AlertService.instance) {
      AlertService.instance = new AlertService();
    }
    return AlertService.instance;
  }

  public initialize(): void {
    this.alertCleanup = onAlert((alert: AlertData) => {
      this.handleAlert(alert);
    });
  }

  private handleAlert(alert: AlertData): void {
    if (!this.settings.enabled) {
      return;
    }

    if (!this.isAlertTypeEnabled(alert)) {
      return;
    }

    this.processAlert(alert);
  }

  public cleanup(): void {
    if (this.alertCleanup) {
      this.alertCleanup();
      this.alertCleanup = null;
    }
  }

  public getSettings(): AlertSettings {
    return { ...this.settings };
  }

  public updateSettings(newSettings: Partial<AlertSettings>): void {
    this.settings = { ...this.settings, ...newSettings };
    this.saveSettings();
  }

  private loadSettings(): AlertSettings {
    try {
      const saved = localStorage.getItem('streamtts-alert-settings');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (error) {
      console.error('AlertService: Failed to load settings', error);
    }

    return {
      enabled: true,
      twitchSubs: true,
      twitchGifts: true,
      twitchRedemptions: true,
      youtubeLive: true,
      volume: 0.8,
    };
  }

  private saveSettings(): void {
    try {
      localStorage.setItem('streamtts-alert-settings', JSON.stringify(this.settings));
    } catch (error) {
      console.error('AlertService: Failed to save settings', error);
    }
  }

  private isAlertTypeEnabled(alert: AlertData): boolean {
    if (alert.platform === 'twitch') {
      switch (alert.alert_type) {
        case 'sub':
          return this.settings.twitchSubs;
        case 'gift':
          return this.settings.twitchGifts;
        case 'redemption':
          return this.settings.twitchRedemptions;
        default:
          return false;
      }
    } else if (alert.platform === 'youtube') {
      switch (alert.alert_type) {
        case 'live':
          return this.settings.youtubeLive;
        default:
          return false;
      }
    }
    return false;
  }

  private processAlert(alert: AlertData): void {
    // Create a temporary audio element for TTS
    const utterance = new SpeechSynthesisUtterance(alert.message);
    utterance.volume = this.settings.volume;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    // Try to use a different voice for alerts
    const voices = speechSynthesis.getVoices();
    if (voices.length > 1) {
      utterance.voice = voices[1];
    }

    speechSynthesis.speak(utterance);

    // Notify listeners
    this.listeners.forEach(listener => listener(alert));
  }

  public addAlertListener(listener: (alert: AlertData) => void): void {
    this.listeners.push(listener);
  }

  public removeAlertListener(listener: (alert: AlertData) => void): void {
    const index = this.listeners.indexOf(listener);
    if (index > -1) {
      this.listeners.splice(index, 1);
    }
  }
}