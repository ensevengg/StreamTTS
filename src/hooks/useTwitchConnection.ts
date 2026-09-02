import { useState, useCallback, useRef } from 'react';
import { connectToTwitchChat, disconnectFromTwitchChat, getTwitchUsername, clearTwitchOAuthToken } from '@/services/twitchService';
import { ttsQueueService } from '@/services/ttsQueueService';
import { useChatStore } from '@/stores/chatStore';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/use-toast';
import { Message } from '@/types/message';
import { ChatConnection } from '@/types/chatSource';
import { TTS_COMMAND_PREFIX, hasTwitchClientId } from '@/config/security';
import { buildTwitchAuthUrl, prepareOAuthState } from '@/lib/oauth-utils';
import { openExternalAuth, isTauriAvailable } from '@/lib/tauri-api';

export function useTwitchConnection() {
  const [isConnecting, setIsConnecting] = useState(false);
  const lastConnectionAttempt = useRef<Record<string, number>>({});
  const { toast } = useToast();

  const connections = useChatStore(s => s.connections);
  const addConnection = useChatStore(s => s.addConnection);
  const removeConnection = useChatStore(s => s.removeConnection);
  const updateConnectionStatus = useChatStore(s => s.updateConnectionStatus);
  const addMessage = useChatStore(s => s.addMessage);
  const isTwitchAuthed = useAuthStore(s => s.isTwitchAuthed);
  const logoutTwitch = useAuthStore(s => s.logoutTwitch);

  const isConnected = connections.some(c => c.type === 'twitch' && c.isConnected);

  const connect = useCallback(async () => {
    if (!isTwitchAuthed) {
      toast({ title: "Twitch Connection", description: "Please login with Twitch first", variant: "destructive" });
      return;
    }
    if (isConnecting) return;
    setIsConnecting(true);

    try {
      const username = await getTwitchUsername();
      if (!username) {
        toast({ title: "Twitch Connection", description: "Could not determine your Twitch username", variant: "destructive" });
        return;
      }

      const lastAttempt = lastConnectionAttempt.current[username] || 0;
      if (Date.now() - lastAttempt < 5000) {
        toast({ title: "Please Wait", description: "Please wait a moment before reconnecting" });
        return;
      }
      lastConnectionAttempt.current[username] = Date.now();

      const existing = connections.find(c => c.type === 'twitch' && c.channelName.toLowerCase() === username.toLowerCase());
      if (existing) {
        toast({ title: "Already Connected", description: `You're already connected to ${username}'s chat` });
        return;
      }

      const connectionId = `twitch-${Date.now()}`;
      const newConnection: ChatConnection = { id: connectionId, type: 'twitch', channelName: username, isConnected: false, status: 'connecting' };
      addConnection(newConnection);

      connectToTwitchChat(
        username,
        (twitchUser, message) => {
          const msg: Message = { id: `twitch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, content: message, timestamp: Date.now(), username: twitchUser, status: 'pending' };
          addMessage(msg);
          if (message.startsWith(TTS_COMMAND_PREFIX)) ttsQueueService.enqueue(msg);
        },
        (connected, error) => {
          updateConnectionStatus(connectionId, connected, error, connected ? 'connected' : 'error');
          if (connected) {
            toast({ title: "Connected to Twitch", description: `Now listening to ${username}'s chat` });
          } else if (error && !error.includes('RECONNECT')) {
            toast({ title: "Twitch Connection Error", description: error, variant: "destructive" });
          }
        }
      );
    } catch (error) {
      toast({ title: "Twitch Connection Error", description: error instanceof Error ? error.message : "Unknown error", variant: "destructive" });
    } finally {
      setIsConnecting(false);
    }
  }, [isTwitchAuthed, isConnecting, connections, addConnection, addMessage, updateConnectionStatus, toast]);

  const disconnectAll = useCallback(async () => {
    const twitchConns = connections.filter(c => c.type === 'twitch');
    if (twitchConns.length === 0) {
      toast({ title: "Twitch", description: "No active Twitch connections to disconnect" });
      return;
    }
    for (const conn of twitchConns) {
      await disconnectFromTwitchChat(conn.channelName);
      removeConnection(conn.id);
    }
    toast({ title: "Twitch Disconnected", description: `Disconnected from ${twitchConns.length} Twitch channel(s)` });
  }, [connections, removeConnection, toast]);

  const handleLogout = useCallback(async () => {
    const twitchConns = connections.filter(c => c.type === 'twitch');
    for (const conn of twitchConns) {
      await disconnectFromTwitchChat(conn.channelName);
      removeConnection(conn.id);
    }
    await clearTwitchOAuthToken();
    logoutTwitch();
    toast({ title: "Twitch Disconnected", description: "You've been logged out of Twitch" });
  }, [connections, removeConnection, logoutTwitch, toast]);

  const startAuth = useCallback(async () => {
    if (!hasTwitchClientId) {
      toast({ title: "Twitch Not Configured", description: "Set VITE_TWITCH_CLIENT_ID in your .env file to enable Twitch login.", variant: "destructive", duration: 8000 });
      return;
    }
    try {
      const { url, state, codeVerifier } = await buildTwitchAuthUrl();
      await prepareOAuthState('twitch', state, codeVerifier);
      if (isTauriAvailable()) {
        await openExternalAuth(url);
      } else {
        window.location.href = url;
      }
      toast({ title: "Twitch Authentication", description: "Complete authentication in the browser window." });
    } catch (error) {
      console.error("Twitch auth failed to start:", error);
      toast({ title: "Authentication Error", description: "Failed to open Twitch authentication page", variant: "destructive" });
    }
  }, [toast]);

  const disconnectById = useCallback((connectionId: string) => {
    const conn = connections.find(c => c.id === connectionId);
    if (!conn) return;
    removeConnection(conn.id);
    if (conn.type === 'twitch') {
      disconnectFromTwitchChat(conn.channelName).catch(err => console.error(`Error disconnecting from ${conn.channelName}:`, err));
    }
    toast({ title: "Disconnected", description: `No longer listening to ${conn.channelName}'s chat` });
  }, [connections, removeConnection, toast]);

  return { isConnected, isConnecting, isTwitchAuthed, connect, disconnectAll, handleLogout, startAuth, disconnectById };
}
