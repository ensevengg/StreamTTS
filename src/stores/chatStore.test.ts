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

const makeConn = (id: string): ChatConnection => ({
  id,
  type: 'twitch',
  channelName: 'streamer',
  isConnected: false,
  status: 'idle',
});

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
    it('adds a connection', () => {
      useChatStore.getState().addConnection(makeConn('twitch-1'));
      expect(useChatStore.getState().connections).toHaveLength(1);
    });

    it('removes a connection', () => {
      useChatStore.getState().addConnection(makeConn('twitch-1'));
      useChatStore.getState().removeConnection('twitch-1');
      expect(useChatStore.getState().connections).toHaveLength(0);
    });

    it('removeConnection handles nonexistent id gracefully', () => {
      useChatStore.getState().addConnection(makeConn('twitch-1'));
      useChatStore.getState().removeConnection('nonexistent');
      expect(useChatStore.getState().connections).toHaveLength(1);
    });

    it('updates connection status', () => {
      useChatStore.getState().addConnection(makeConn('twitch-1'));
      useChatStore.getState().updateConnectionStatus('twitch-1', true);
      expect(useChatStore.getState().connections[0].isConnected).toBe(true);
      expect(useChatStore.getState().connections[0].error).toBeUndefined();
    });

    it('updateConnectionStatus sets error', () => {
      useChatStore.getState().addConnection(makeConn('twitch-1'));
      useChatStore.getState().updateConnectionStatus('twitch-1', false, 'Network down');
      expect(useChatStore.getState().connections[0].isConnected).toBe(false);
      expect(useChatStore.getState().connections[0].error).toBe('Network down');
    });

    it('tracks multiple platforms independently', () => {
      const store = useChatStore.getState();
      store.addConnection({ ...makeConn('twitch-1'), type: 'twitch' });
      store.addConnection({ ...makeConn('youtube-1'), type: 'youtube' });
      store.updateConnectionStatus('twitch-1', true);
      store.updateConnectionStatus('youtube-1', true);
      expect(useChatStore.getState().connections.filter(c => c.isConnected)).toHaveLength(2);
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
