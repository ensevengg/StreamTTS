import { useEffect } from 'react';
import { validateOAuthState } from '@/config/security';
import { onAuthCallback, type AuthCallbackData } from '@/lib/tauri-api';
import { saveTwitchOAuthToken } from '@/services/twitchService';
import { saveYoutubeTokens, getValidYoutubeToken, YouTubeTokens } from '@/services/youtubeService';

interface UseOAuthCallbackOptions {
  onTwitchAuth: () => void;
  onYoutubeAuth: () => void;
  toast: (opts: { id?: string; title: string; description?: string; variant?: 'default' | 'destructive'; duration?: number }) => void;
}

export const useOAuthCallback = ({
  onTwitchAuth,
  onYoutubeAuth,
  toast,
}: UseOAuthCallbackOptions): void => {
  useEffect(() => {
    const processAuthData = async (data: AuthCallbackData) => {
      if (data && data.state && !validateOAuthState(data.state)) {
        console.error('OAuth state validation failed - possible CSRF attack');
        toast({
          id: 'oauth-csrf-error',
          title: "Security Error",
          description: "OAuth state validation failed. Please try authenticating again.",
          variant: "destructive"
        });
        return;
      }

      if (data && data.type === 'twitch-oauth-callback') {
        if (data.token) {
          await saveTwitchOAuthToken(data.token, data.refresh_token, data.expires_in);
          onTwitchAuth();
          toast({
            id: 'twitch-auth-success',
            title: "Twitch Authentication Successful",
            description: "You can now connect to your Twitch channel"
          });
        } else if (data.error) {
          toast({
            id: 'twitch-auth-failed',
            title: "Twitch Authentication Failed",
            description: `Twitch error: ${data.error}`,
            variant: "destructive"
          });
        }
      }

      if (data && data.type === 'youtube-oauth-callback') {
        if (!data.token) {
          if (data.error) {
            toast({
              id: 'youtube-auth-failed',
              title: "YouTube Authentication Failed",
              description: `YouTube error: ${data.error}`,
              variant: "destructive"
            });
          }
          return;
        }
        try {
          if (data.refresh_token && data.expires_in) {
            const tokens: YouTubeTokens = {
              access_token: data.token,
              refresh_token: data.refresh_token,
              expires_at: Date.now() + (data.expires_in * 1000),
            };
            await saveYoutubeTokens(tokens);
          }

          const token = await getValidYoutubeToken();

          if (token) {
            onYoutubeAuth();
            toast({
              id: 'youtube-auth-success',
              title: "YouTube Authentication Successful",
              description: "You can now connect to your YouTube live stream"
            });
          } else {
            toast({
              id: 'youtube-permission-issue',
              title: "YouTube Permission Issue",
              description: "Authentication succeeded but lacks required permissions for live chat. Please log out and log in again to grant full YouTube access.",
              variant: "destructive",
              duration: 8000
            });
          }
        } catch (error) {
          console.error("Error in YouTube auth callback:", error);
          toast({
            id: 'youtube-auth-error',
            title: "YouTube Authentication Error",
            description: "There was a problem authenticating with YouTube. Please try again.",
            variant: "destructive"
          });
        }
      }
    };

    const unlistenAuth = onAuthCallback((data) => {
      void processAuthData(data);
    });

    return () => {
      unlistenAuth();
    };
  }, [onTwitchAuth, onYoutubeAuth, toast]);
};
