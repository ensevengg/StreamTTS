import { useState, useCallback, useRef } from 'react';
import { connectToYouTubeLiveChat, clearYoutubeOAuthToken } from '@/services/youtubeService';
import { ttsQueueService } from '@/services/ttsQueueService';
import { useChatStore } from '@/stores/chatStore';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/hooks/use-toast';
import { useYoutubeBroadcasts } from '@/hooks/useYoutubeQueries';
import { Message } from '@/types/message';
import { ChatConnection } from '@/types/chatSource';
import { TTS_COMMAND_PREFIX, hasYoutubeClientId } from '@/config/security';
import { buildYouTubeAuthUrl, prepareOAuthState } from '@/lib/oauth-utils';
import { openExternalAuth, isTauriAvailable } from '@/lib/tauri-api';

export function useYoutubeConnection() {
  const [isConnecting, setIsConnecting] = useState(false);
  const { toast } = useToast();

  const connections = useChatStore(s => s.connections);
  const addConnection = useChatStore(s => s.addConnection);
  const removeConnection = useChatStore(s => s.removeConnection);
  const updateConnectionStatus = useChatStore(s => s.updateConnectionStatus);
  const addMessage = useChatStore(s => s.addMessage);
  const isYoutubeAuthed = useAuthStore(s => s.isYoutubeAuthed);
  const logoutYoutube = useAuthStore(s => s.logoutYoutube);

  const { data: broadcasts, refetch: refetchBroadcasts } = useYoutubeBroadcasts();
  const disconnectFns = useRef<Record<string, () => void>>({});

  const isConnected = connections.some(c => c.type === 'youtube' && c.isConnected);

  const connect = useCallback(async () => {
    if (!isYoutubeAuthed) {
      toast({ title: "YouTube Connection", description: "Please login with YouTube first", variant: "destructive" });
      return;
    }
    if (isConnecting) return;
    setIsConnecting(true);

    try {
      let activeBroadcasts = (await refetchBroadcasts().catch(() => ({ data: [] as unknown[] }))).data ?? [];
      if (activeBroadcasts.length === 0) {
        toast({ title: "No Active Streams", description: "Start a live stream on YouTube, then try again.", variant: "destructive", duration: 5000 });
        setIsConnecting(false);
        return;
      }

      const broadcast = activeBroadcasts[0] as { id: string; snippet?: { title?: string } };
      const broadcastId = broadcast.id;
      const broadcastTitle = broadcast.snippet?.title || 'Unknown';

      const existing = connections.find(c => c.type === 'youtube' && c.channelName === broadcastTitle);
      if (existing) {
        toast({ title: "Already Connected", description: "You're already connected to this YouTube live stream" });
        return;
      }

      const connectionId = `youtube-${Date.now()}`;
      const newConnection: ChatConnection = { id: connectionId, type: 'youtube', channelName: broadcastTitle || broadcastId, isConnected: false, status: 'connecting' };
      addConnection(newConnection);

      try {
        const { disconnect } = await connectToYouTubeLiveChat(
          broadcastId,
          (ytMessage) => {
            const text = ytMessage.snippet?.displayMessage || '';
            const msg: Message = {
              id: `youtube-${ytMessage.id || Date.now()}`,
              content: text,
              timestamp: ytMessage.snippet?.publishedAt ? new Date(ytMessage.snippet.publishedAt).getTime() : Date.now(),
              username: ytMessage.authorDetails?.displayName || 'Anonymous',
              status: 'pending',
            };
            addMessage(msg);
            if (text.startsWith(TTS_COMMAND_PREFIX)) ttsQueueService.enqueue(msg);
          },
          (error) => {
            updateConnectionStatus(connectionId, false, error.message, 'error');
            toast({ title: "Connection Error", description: error.message || "Could not connect to YouTube chat.", variant: "destructive", duration: 5000 });
          }
        );

        disconnectFns.current[connectionId] = disconnect;
        updateConnectionStatus(connectionId, true, undefined, 'connected');
        toast({ title: "Connected to YouTube", description: `Now listening to live chat for: ${broadcastTitle}` });
      } catch (connectionError) {
        removeConnection(connectionId);
        if (connectionError instanceof Error) {
          toast({ title: "Connection Error", description: connectionError.message, variant: "destructive", duration: 5000 });
        }
      }
    } catch (error) {
      toast({ title: "Connection Error", description: error instanceof Error ? error.message : "Something went wrong. Please try again.", variant: "destructive", duration: 5000 });
    } finally {
      setIsConnecting(false);
    }
  }, [isYoutubeAuthed, isConnecting, connections, addConnection, addMessage, updateConnectionStatus, removeConnection, refetchBroadcasts, toast]);

  const disconnectAll = useCallback(() => {
    const youtubeConns = connections.filter(c => c.type === 'youtube');
    if (youtubeConns.length === 0) {
      toast({ title: "YouTube", description: "No active YouTube connections to disconnect" });
      return;
    }
    youtubeConns.forEach(conn => {
      removeConnection(conn.id);
      const disconnect = disconnectFns.current[conn.id];
      if (disconnect) {
        disconnect();
        delete disconnectFns.current[conn.id];
      }
    });
    toast({ title: "YouTube Disconnected", description: "Successfully disconnected from all YouTube live streams" });
  }, [connections, removeConnection, toast]);

  const handleLogout = useCallback(async () => {
    const youtubeConns = connections.filter(c => c.type === 'youtube');
    youtubeConns.forEach(conn => {
      removeConnection(conn.id);
      const disconnect = disconnectFns.current[conn.id];
      if (disconnect) {
        disconnect();
        delete disconnectFns.current[conn.id];
      }
    });
    await clearYoutubeOAuthToken();
    logoutYoutube();
    toast({ title: "YouTube Disconnected", description: "You've been logged out of YouTube" });
  }, [connections, removeConnection, logoutYoutube, toast]);

  const startAuth = useCallback(async () => {
    if (!hasYoutubeClientId) {
      toast({ title: "YouTube Not Configured", description: "Set VITE_YOUTUBE_CLIENT_ID in your .env file to enable YouTube login.", variant: "destructive", duration: 8000 });
      return;
    }
    try {
      const { url, state, codeVerifier } = await buildYouTubeAuthUrl();
      await prepareOAuthState('youtube', state, codeVerifier);
      if (isTauriAvailable()) {
        await openExternalAuth(url);
      } else {
        window.location.href = url;
      }
      toast({ title: "YouTube Authentication", description: "Complete authentication in the browser window." });
    } catch (error) {
      console.error("YouTube auth failed to start:", error);
      toast({ title: "Authentication Error", description: "Failed to open YouTube authentication page", variant: "destructive" });
    }
  }, [toast]);

  const resetAuth = useCallback(async () => {
    await clearYoutubeOAuthToken();
    logoutYoutube();
    toast({ title: "YouTube Authentication Reset", description: "Please log in again to reconnect YouTube." });
  }, [logoutYoutube, toast]);

  const disconnectById = useCallback((connectionId: string) => {
    const conn = connections.find(c => c.id === connectionId);
    if (!conn) return;
    removeConnection(conn.id);
    const disconnect = disconnectFns.current[connectionId];
    if (disconnect) {
      disconnect();
      delete disconnectFns.current[connectionId];
    }
    toast({ title: "Disconnected", description: `No longer listening to ${conn.channelName}'s chat` });
  }, [connections, removeConnection, toast]);

  return { isConnected, isConnecting, isYoutubeAuthed, connect, disconnectAll, handleLogout, startAuth, resetAuth, disconnectById };
}
