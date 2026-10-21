import React, { useEffect, useState } from 'react';
import { Twitch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { errorMessage } from '@/lib/http';
import { openExternal } from '@/lib/tauri-api';
import { cancelTwitchLogin, startTwitchLogin } from '@/services/authService';
import { useAuthStore } from '@/stores/authStore';

const TwitchLoginButton: React.FC = () => {
  const { toast } = useToast();
  const pending = useAuthStore(s => s.twitchLogin);
  const setTwitchLogin = useAuthStore(s => s.setTwitchLogin);
  const [starting, setStarting] = useState(false);

  // The device code stops working after a few minutes; drop the prompt then.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setTwitchLogin(null), Math.max(0, pending.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pending, setTwitchLogin]);

  const start = async () => {
    setStarting(true);
    try {
      const code = await startTwitchLogin();
      setTwitchLogin({
        userCode: code.user_code,
        verificationUri: code.verification_uri,
        expiresAt: Date.now() + code.expires_in * 1000,
      });
    } catch (error) {
      toast({ title: "Couldn't start the Twitch login", description: errorMessage(error), variant: 'destructive' });
    } finally {
      setStarting(false);
    }
  };

  const cancel = () => {
    setTwitchLogin(null);
    void cancelTwitchLogin();
  };

  if (pending) {
    return (
      <div className="space-y-3 rounded-lg border border-purple-500/40 bg-purple-500/5 p-4">
        <p className="text-sm">
          Approve StreamTTS on the Twitch page that just opened in your browser. It should show this code:
        </p>
        <p className="text-center font-mono text-2xl tracking-[0.3em]">{pending.userCode}</p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => void openExternal(pending.verificationUri).catch(() => {})}
          >
            Open Twitch again
          </Button>
          <Button variant="ghost" onClick={cancel}>Cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <Button onClick={start} disabled={starting} className="bg-purple-600 hover:bg-purple-700 text-white">
      <Twitch className="h-4 w-4 mr-2" />
      {starting ? 'Opening Twitch…' : 'Log in with Twitch'}
    </Button>
  );
};

export default TwitchLoginButton;
