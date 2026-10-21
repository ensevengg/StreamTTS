import React, { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { errorMessage } from '@/lib/http';
import {
  fetchActiveBroadcasts,
  fetchOwnChannelTitle,
  getValidYoutubeToken,
  YouTubeApiError,
} from '@/services/youtubeService';

const describe = (error: unknown): string => {
  if (error instanceof YouTubeApiError) {
    if (error.status === 401) return 'Your session expired. Log in again.';
    if (error.reason === 'quotaExceeded') return "YouTube's daily API quota is used up. Try again tomorrow.";
    if (error.reason === 'liveStreamingNotEnabled') return 'Live streaming is not enabled on this channel. Enable it in YouTube Studio.';
    return `${error.status}: ${error.message}`;
  }
  return `Could not reach YouTube: ${errorMessage(error)}`;
};

/** Checks login, channel access and live broadcasts in one click. */
const DiagnoseYouTube: React.FC = () => {
  const { toast } = useToast();
  const [running, setRunning] = useState(false);

  const diagnose = useCallback(async () => {
    setRunning(true);
    try {
      const token = await getValidYoutubeToken();
      if (token.status !== 'ok') {
        toast({
          title: 'Not logged in',
          description: token.status === 'signed_out' ? 'Log in to YouTube first.' : token.reason,
          variant: 'destructive',
        });
        return;
      }
      const channel = await fetchOwnChannelTitle(token.token);
      const broadcasts = await fetchActiveBroadcasts(token.token);
      const withChat = broadcasts.filter(b => b.snippet?.liveChatId).length;
      toast({
        title: `Channel: ${channel ?? 'unknown'}`,
        description: broadcasts.length === 0
          ? 'No live broadcast right now. Connecting will wait until you go live.'
          : `${broadcasts.length} live broadcast(s), ${withChat} with chat. Ready to connect.`,
      });
    } catch (error) {
      toast({ title: 'YouTube check failed', description: describe(error), variant: 'destructive' });
    } finally {
      setRunning(false);
    }
  }, [toast]);

  return (
    <Button
      onClick={diagnose}
      disabled={running}
      variant="outline"
      className="border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/20"
    >
      {running ? 'Checking…' : 'Check setup'}
    </Button>
  );
};

export default DiagnoseYouTube;
