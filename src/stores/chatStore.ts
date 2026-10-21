import { create } from 'zustand';
import { Message, MessageStatus } from '@/types/message';
import { ChatConnection, ChatPlatform } from '@/types/chatSource';

const MAX_MESSAGES = 500;

interface ChatState {
  messages: Message[];
  connections: ChatConnection[];
  activeTab: string;
  isProcessing: boolean;
  addMessage: (message: Message) => void;
  updateMessageStatus: (id: string, status: MessageStatus, detail?: string) => void;
  upsertConnection: (connection: ChatConnection) => void;
  updateConnection: (id: ChatPlatform, patch: Partial<Omit<ChatConnection, 'id' | 'type'>>) => void;
  removeConnection: (id: ChatPlatform) => void;
  setActiveTab: (tab: string) => void;
  setIsProcessing: (processing: boolean) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  connections: [],
  activeTab: 'chat',
  isProcessing: false,

  addMessage: (message) =>
    set((state) => {
      const next = [...state.messages, message];
      return { messages: next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next };
    }),

  updateMessageStatus: (id, status, detail) =>
    set((state) => {
      const index = state.messages.findIndex((msg) => msg.id === id);
      if (index === -1) return state;
      const messages = state.messages.slice();
      messages[index] = { ...messages[index], status, statusDetail: detail };
      return { messages };
    }),

  upsertConnection: (connection) =>
    set((state) => ({
      connections: [...state.connections.filter((c) => c.id !== connection.id), connection],
    })),

  updateConnection: (id, patch) =>
    set((state) => ({
      connections: state.connections.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    })),

  removeConnection: (id) =>
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
    })),

  setActiveTab: (tab) => set({ activeTab: tab }),

  setIsProcessing: (processing) => set({ isProcessing: processing }),
}));
