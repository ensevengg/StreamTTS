import { create } from 'zustand';
import { Message } from '@/types/message';
import { ChatConnection, ChatPlatform } from '@/types/chatSource';

const MAX_MESSAGES = 500;

interface ChatState {
  messages: Message[];
  connections: ChatConnection[];
  activeTab: string;
  isProcessing: boolean;
  addMessage: (message: Message) => void;
  updateMessageStatus: (id: string, status: Message['status']) => void;
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

  updateMessageStatus: (id, status) =>
    set((state) => ({
      messages: state.messages.map((msg) =>
        msg.id === id ? { ...msg, status } : msg
      ),
    })),

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
