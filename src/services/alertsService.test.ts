import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/services/chatSpeech', () => ({ speakAlert: vi.fn() }));

import { speakAlert } from '@/services/chatSpeech';
import { AlertService, DEFAULT_ALERT_SETTINGS, type AlertData } from './alertsService';

const twitchSub: AlertData = { platform: 'twitch', alert_type: 'sub', user_name: 'A', message: 'A just subscribed!' };
const superChat: AlertData = { platform: 'youtube', alert_type: 'superchat', user_name: 'B', message: 'B sent a Super Chat!' };

describe('AlertService', () => {
  beforeEach(() => {
    vi.mocked(speakAlert).mockClear();
    AlertService.getInstance().updateSettings(DEFAULT_ALERT_SETTINGS);
  });

  it('speaks and shows enabled alerts at the alert volume', () => {
    const service = AlertService.getInstance();
    const shown = vi.fn();
    const unsubscribe = service.subscribe(shown);
    service.updateSettings({ volume: 0.4 });

    service.publish(twitchSub);
    expect(speakAlert).toHaveBeenCalledWith(twitchSub, 0.4);
    expect(shown).toHaveBeenCalledWith(twitchSub);
    unsubscribe();
  });

  it('drops alerts whose type is turned off', () => {
    const service = AlertService.getInstance();
    service.updateSettings({ youtubeSuperChats: false });
    service.publish(superChat);
    service.updateSettings({ youtubeSuperChats: true, enabled: false });
    service.publish(superChat);
    expect(speakAlert).not.toHaveBeenCalled();
  });

  it('keeps the EventSub connection only while a Twitch alert is wanted', () => {
    const service = AlertService.getInstance();
    expect(service.wantsTwitchEvents()).toBe(true);
    service.updateSettings({ twitchSubs: false, twitchGifts: false, twitchRedemptions: false });
    expect(service.wantsTwitchEvents()).toBe(false);
  });

  it('notifies settings listeners', () => {
    const service = AlertService.getInstance();
    const listener = vi.fn();
    const off = service.onSettingsChange(listener);
    service.updateSettings({ volume: 0.5 });
    off();
    service.updateSettings({ volume: 0.6 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('persists settings', () => {
    AlertService.getInstance().updateSettings({ twitchGifts: false });
    expect(JSON.parse(localStorage.getItem('streamtts-alert-settings')!).twitchGifts).toBe(false);
  });
});
