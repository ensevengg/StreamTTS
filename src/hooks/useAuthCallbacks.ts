import { useEffect } from 'react';
import { toast } from '@/hooks/use-toast';
import { onAuthCallback, onOAuthServerError } from '@/lib/tauri-api';
import { completeLogin } from '@/services/authService';
import { signOutTwitch } from '@/services/chatSessions';
import { checkTwitchSession } from '@/services/twitchService';
import { useAuthStore } from '@/stores/authStore';

const TWITCH_VALIDATE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * App-wide login plumbing, mounted once in App so a login finishes no matter
 * which page or tab is showing when the browser hands control back.
 */
export function useAuthCallbacks(): void {
  useEffect(() => onAuthCallback((data) => {
    void (async () => {
      const store = useAuthStore.getState();
      const label = data.service === 'twitch' ? 'Twitch' : 'YouTube';
      if (data.service === 'twitch') store.setTwitchLogin(null);
      else store.setYoutubeLoginPending(false);

      const result = await completeLogin(data);
      if (!result.ok) {
        toast({ title: `${label} login failed`, description: result.error, variant: 'destructive' });
        return;
      }
      if (data.service === 'twitch') store.setTwitchAuth(true);
      else store.setYoutubeAuth(true);
      toast({ title: `Logged in to ${label}`, description: 'You can now connect to your live chat.' });
    })();
  }), []);

  useEffect(() => onOAuthServerError((message) => {
    toast({
      title: 'Login server failed to start',
      description: `YouTube login won't work until StreamTTS is restarted. ${message}`,
      variant: 'destructive',
    });
  }), []);

  // Twitch requires apps to validate tokens at startup and hourly. Network
  // trouble is ignored; only a token Twitch rejects ends the session.
  const isTwitchAuthed = useAuthStore(s => s.isTwitchAuthed);
  useEffect(() => {
    if (!isTwitchAuthed) return;
    let cancelled = false;
    const check = async () => {
      const result = await checkTwitchSession();
      if (cancelled || result.status !== 'signed_out') return;
      await signOutTwitch();
      toast({
        title: 'Twitch session expired',
        description: 'Log in to Twitch again to keep reading chat.',
        variant: 'destructive',
      });
    };
    void check();
    const interval = setInterval(check, TWITCH_VALIDATE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isTwitchAuthed]);
}
