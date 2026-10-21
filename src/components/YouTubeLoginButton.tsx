import React from 'react';
import { Youtube } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { errorMessage } from '@/lib/http';
import { startYoutubeLogin } from '@/services/authService';
import { useAuthStore } from '@/stores/authStore';

const YouTubeLoginButton: React.FC = () => {
  const { toast } = useToast();
  const pending = useAuthStore(s => s.youtubeLoginPending);
  const setPending = useAuthStore(s => s.setYoutubeLoginPending);

  const start = async () => {
    setPending(true);
    try {
      await startYoutubeLogin();
    } catch (error) {
      setPending(false);
      toast({ title: "Couldn't start the YouTube login", description: errorMessage(error), variant: 'destructive' });
    }
  };

  if (pending) {
    return (
      <div className="space-y-3 rounded-lg border border-red-500/40 bg-red-500/5 p-4">
        <p className="text-sm">Finish signing in with Google in your browser, then come back here.</p>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={start}>Open the login page again</Button>
          {/* The backend expires the attempt on its own; this just resets the UI. */}
          <Button variant="ghost" onClick={() => setPending(false)}>Cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <Button onClick={start} className="bg-red-600 hover:bg-red-700 text-white">
      <Youtube className="h-4 w-4 mr-2" />
      Log in with YouTube
    </Button>
  );
};

export default YouTubeLoginButton;
