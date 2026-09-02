import { create } from 'zustand';
import { Message } from '@/types/message';
import { ChatConnection, ConnectionStatus } from '@/types/chatSource';

const MAX_MESSAGES = 500;

interface ChatState {
  messages: Message[];
  connections: ChatConnection[];
  activeTab: string;
  isProcessing: boolean;
  addMessage: (message: Message) => void;
  updateMessageStatus: (id: string, status: Message['status']) => void;
  addConnection: (connection: ChatConnection) => void;
  removeConnection: (id: string) => void;
  updateConnectionStatus: (id: string, isConnected: boolean, error?: string, status?: ConnectionStatus) => void;
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

  addConnection: (connection) =>
    set((state) => ({ connections: [...state.connections, connection] })),

  removeConnection: (id) =>
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id),
    })),

  updateConnectionStatus: (id, isConnected, error, status) =>
    set((state) => ({
      connections: state.connections.map((c) =>
        c.id === id ? { ...c, isConnected, error, ...(status ? { status } : {}) } : c
      ),
    })),

  setActiveTab: (tab) => set({ activeTab: tab }),

  setIsProcessing: (processing) => set({ isProcessing: processing }),
}));
