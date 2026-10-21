import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from './chatStore';
import type { Message } from '@/types/message';
import type { ChatConnection } from '@/types/chatSource';

const makeMsg = (id: string): Message => ({
  id,
  content: 'hello',
  timestamp: Date.now(),
  username: 'user',
  status: 'pending',
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
    it('adds a message', () => {
      useChatStore.getState().addMessage(makeMsg('1'));
      expect(useChatStore.getState().messages).toHaveLength(1);
    });

    it('caps messages at MAX_MESSAGES (500)', () => {
      const store = useChatStore.getState();
      for (let i = 0; i < 505; i++) {
        store.addMessage(makeMsg(`msg-${i}`));
      }
      expect(useChatStore.getState().messages).toHaveLength(500);
    });

    it('keeps the most recent messages when capped', () => {
      const store = useChatStore.getState();
      for (let i = 0; i < 510; i++) {
        store.addMessage(makeMsg(`msg-${i}`));
      }
      const ids = useChatStore.getState().messages.map(m => m.id);
      expect(ids[0]).toBe('msg-10');
      expect(ids[ids.length - 1]).toBe('msg-509');
    });

    it('updates message status', () => {
      useChatStore.getState().addMessage(makeMsg('1'));
      useChatStore.getState().updateMessageStatus('1', 'playing');
      expect(useChatStore.getState().messages[0].status).toBe('playing');
    });

    it('updateMessageStatus does nothing for unknown id', () => {
      useChatStore.getState().addMessage(makeMsg('1'));
      useChatStore.getState().updateMessageStatus('nonexistent', 'completed');
      expect(useChatStore.getState().messages).toHaveLength(1);
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

  describe('activeTab and isProcessing', () => {
    it('defaults to chat tab', () => {
      expect(useChatStore.getState().activeTab).toBe('chat');
    });

    it('setActiveTab changes tab', () => {
      useChatStore.getState().setActiveTab('settings');
      expect(useChatStore.getState().activeTab).toBe('settings');
    });

    it('setIsProcessing toggles processing', () => {
      useChatStore.getState().setIsProcessing(true);
      expect(useChatStore.getState().isProcessing).toBe(true);
      useChatStore.getState().setIsProcessing(false);
      expect(useChatStore.getState().isProcessing).toBe(false);
    });
  });
});
