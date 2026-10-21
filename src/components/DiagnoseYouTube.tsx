import React, { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { getValidYoutubeToken } from '@/services/youtubeService';


interface DiagnoseYouTubeProps {
  onDiagnosticsComplete?: () => void;
}

const DiagnoseYouTube: React.FC<DiagnoseYouTubeProps> = ({ onDiagnosticsComplete }) => {
  const { toast } = useToast();

  const diagnoseYouTubeIssues = useCallback(async () => {
    const result = await getValidYoutubeToken();
    const token = result.status === 'ok' ? result.token : null;
    if (!token) {
      toast({
        title: "Not Logged In",
        description: "Please log in to YouTube first.",
        variant: "destructive",
        duration: 5000
      });
      return;
    }

    try {
      const channelResponse = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (channelResponse.ok) {
        const channelData = await channelResponse.json();
        toast({
          title: "✅ Connected",
          description: `Connected to channel: ${channelData.items?.[0]?.snippet?.title || 'Unknown'}`,
          duration: 5000
        });
      } else {
        if (channelResponse.status === 403) {
          toast({
            title: "❌ Permission Denied",
            description: "Enable live streaming in YouTube Studio and log in again.",
            variant: "destructive",
            duration: 5000
          });
        } else if (channelResponse.status === 401) {
          toast({
            title: "❌ Session Expired",
            description: "Please log in again.",
            variant: "destructive",
            duration: 5000
          });
        } else if (channelResponse.status === 429) {
          toast({
            title: "❌ Limit Reached",
            description: "Too many requests. Wait a moment and try again.",
            variant: "destructive",
            duration: 5000
          });
        }
        return;
      }


      const broadcastResponse = await fetch('https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet&broadcastStatus=active', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (broadcastResponse.ok) {
        const broadcastData = await broadcastResponse.json();
        if (broadcastData.items?.length === 0) {
          toast({
            title: "ℹ️ No Active Streams",
            description: "Start a live stream on YouTube to test chat connection.",
            duration: 6000
          });
        } else {
          toast({
            title: "✅ Active Broadcasts Found",

            description: `Found ${broadcastData.items.length} active broadcast(s). Ready to connect!`,
          });
        }
      } else {
        toast({
          title: "❌ Broadcast Access Failed",
          description: `HTTP ${broadcastResponse.status}: Cannot access live broadcasts. Check permissions.`,

          variant: "destructive",
          duration: 8000
        });
      }

      toast({
        title: "YouTube Diagnostic Complete",
        description: "Check the browser console (F12) for detailed results.",
        duration: 5000
      });

      onDiagnosticsComplete?.();
    } catch (error) {
      console.error("Diagnostic error:", error);
      toast({
        title: "Diagnostic Error",
        description: `Failed to run diagnostics: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: "destructive",
        duration: 8000
      });
    }
  }, [toast, onDiagnosticsComplete]);

  return (
    <Button
      onClick={diagnoseYouTubeIssues}
      variant="outline"
      className="border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/20"
    >
      🔍 Diagnose
    </Button>
  );
};

export default DiagnoseYouTube;
