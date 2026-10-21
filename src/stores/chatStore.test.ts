import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from './chatStore';
import type { Message } from '@/types/message';
import type { ChatConnection } from '@/types/chatSource';

const makeMsg = (id: string): Message => ({
  id,
  content: 'hello',
  timestamp: Date.now(),
  username: 'user',
});

const twitch: ChatConnection = { id: 'twitch', type: 'twitch', channelName: 'streamer', status: 'connecting' };

describe('chatStore', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      connections: [],
      activeTab: 'chat',
      isProcessing: false,
    });
  });

  describe('messages', () => {
    it('keeps the most recent 500 messages', () => {
      const store = useChatStore.getState();
      for (let i = 0; i < 510; i++) {
        store.addMessage(makeMsg(`msg-${i}`));
      }
      const ids = useChatStore.getState().messages.map(m => m.id);
      expect(ids).toHaveLength(500);
      expect(ids[0]).toBe('msg-10');
      expect(ids[ids.length - 1]).toBe('msg-509');
    });

    it('updates a message status with its reason', () => {
      useChatStore.getState().addMessage(makeMsg('1'));
      useChatStore.getState().updateMessageStatus('1', 'skipped', 'Viewer cooldown');
      expect(useChatStore.getState().messages[0]).toMatchObject({ status: 'skipped', statusDetail: 'Viewer cooldown' });
    });

    it('leaves state untouched for an unknown id', () => {
      useChatStore.getState().addMessage(makeMsg('1'));
      const before = useChatStore.getState().messages;
      useChatStore.getState().updateMessageStatus('nonexistent', 'completed');
      expect(useChatStore.getState().messages).toBe(before);
    });
  });

  describe('connections', () => {
    it('keeps one connection per platform', () => {
      const store = useChatStore.getState();
      store.upsertConnection(twitch);
      store.upsertConnection({ ...twitch, channelName: 'other' });
      expect(useChatStore.getState().connections).toEqual([{ ...twitch, channelName: 'other' }]);
    });

    it('patches status and detail', () => {
      const store = useChatStore.getState();
      store.upsertConnection(twitch);
      store.updateConnection('twitch', { status: 'reconnecting', detail: 'Ping timeout' });
      expect(useChatStore.getState().connections[0]).toMatchObject({ status: 'reconnecting', detail: 'Ping timeout' });
    });

    it('removes a connection', () => {
      const store = useChatStore.getState();
      store.upsertConnection(twitch);
      store.upsertConnection({ id: 'youtube', type: 'youtube', channelName: 'yt', status: 'waiting' });
      store.removeConnection('twitch');
      expect(useChatStore.getState().connections.map(c => c.id)).toEqual(['youtube']);
    });
  });

  it('tracks the active tab and speech state', () => {
    useChatStore.getState().setActiveTab('settings');
    useChatStore.getState().setIsProcessing(true);
    expect(useChatStore.getState()).toMatchObject({ activeTab: 'settings', isProcessing: true });
  });
});
