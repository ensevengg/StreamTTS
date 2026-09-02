import React from 'react';
import { Button } from '@/components/ui/button';
import { Youtube, CheckCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { saveYoutubeTokens, hasYoutubeOAuthToken, clearYoutubeOAuthToken, YouTubeTokens } from '@/services/youtubeService';
import { openExternalAuth, onAuthCallback, isTauriAvailable, AuthCallbackData } from '@/lib/tauri-api';
import { prepareOAuthState, buildYouTubeAuthUrl } from '@/lib/oauth-utils';



interface YouTubeOAuthButtonProps {
  onAuthChange: (isAuthed: boolean) => void;
}

const YouTubeOAuthButton: React.FC<YouTubeOAuthButtonProps> = ({ onAuthChange }) => {
  const { toast } = useToast();
  const [isAuthorized, setIsAuthorized] = React.useState<boolean>(false);
  const [isAuthenticating, setIsAuthenticating] = React.useState<boolean>(false);
  const [authError, setAuthError] = React.useState<string | null>(null);
  const pendingStateRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const syncTokenState = async () => {
      const hasToken = await hasYoutubeOAuthToken();
      if (hasToken !== isAuthorized) {
        setIsAuthorized(hasToken);
        onAuthChange(hasToken);
      }
    };

    void syncTokenState();

    window.addEventListener('storage', syncTokenState);
    return () => window.removeEventListener('storage', syncTokenState);
  }, [isAuthorized, onAuthChange]);

  React.useEffect(() => {
    let mounted = true;

    const handleAuthCallback = async (data: AuthCallbackData) => {
      if (!mounted) return;
      if (data.type !== 'youtube-oauth-callback') return;

      if (pendingStateRef.current && data.state !== pendingStateRef.current) {
        console.error('YouTubeOAuthButton: OAuth state mismatch - possible CSRF attack');
        setIsAuthenticating(false);
        toast({
          title: "Security Error",
          description: "OAuth state validation failed. Please try again.",
          variant: "destructive"
        });
        return;
      }

      if (data.token && data.refresh_token && data.expires_in) {
        pendingStateRef.current = null;
        const tokens: YouTubeTokens = {
          access_token: data.token,
          refresh_token: data.refresh_token,
          expires_at: Date.now() + (data.expires_in * 1000),
        };
        await saveYoutubeTokens(tokens);
        setIsAuthorized(true);
        onAuthChange(true);
        setIsAuthenticating(false);
        setAuthError(null);

        toast({
          title: "YouTube Authentication Successful",
          description: "You can now connect to your YouTube live streams"
        });
      } else if (data.error) {
        pendingStateRef.current = null;
        console.error("Auth error:", data.error);
        setIsAuthenticating(false);
        setAuthError(data.error);

        toast({
          title: "Authentication Failed",
          description: `YouTube error: ${data.error}`,
          variant: "destructive"
        });
      }
    };

    let unlistenAuth = () => {};
    try {
      unlistenAuth = onAuthCallback(handleAuthCallback);
    } catch (e) {
      console.warn("Could not set up Tauri auth callback:", e);
    }

    return () => {
      mounted = false;
      try {
        unlistenAuth();
      } catch (e) {
        console.warn("Error cleaning up auth listener:", e);
      }
    };
  }, [onAuthChange, toast]);
 
  const handleConnect = async () => {
    setIsAuthenticating(true);
    setAuthError(null);

    if (isTauriAvailable()) {
      try {
        const { url, state, codeVerifier } = await buildYouTubeAuthUrl();
        pendingStateRef.current = state;
        // Register the state (and PKCE verifier) with the backend before the
        // browser flow starts, so the loopback callback can consume it once.
        await prepareOAuthState('youtube', state, codeVerifier);
        await openExternalAuth(url);
      } catch (error) {
        pendingStateRef.current = null;
        console.error("Error opening auth URL:", error);
        setIsAuthenticating(false);
        setAuthError("Failed to open browser");

        toast({
          title: "Authentication Error",
          description: "Failed to open YouTube authentication page",
          variant: "destructive"
        });
      }
    } else {
      try {
        const { url, state } = await buildYouTubeAuthUrl();
        pendingStateRef.current = state;
        window.location.href = url;
      } catch (error) {
        console.error("Failed to build auth URL:", error);
        setIsAuthenticating(false);
      }
    }
  };

  const handleDisconnect = async () => {
    await clearYoutubeOAuthToken();
    setIsAuthorized(false);
    onAuthChange(false);
    setAuthError(null);
    
    toast({
      title: "YouTube Disconnected",
      description: "You've been logged out of YouTube"
    });
  };

  return (
    <div className="flex flex-col space-y-2">
      {isAuthorized ? (
        <Button 
          variant="outline" 
          className="bg-green-500 text-white hover:bg-red-600 w-full"
          onClick={handleDisconnect}
        >
          <CheckCircle className="mr-2 h-4 w-4" />
          Connected to YouTube
        </Button>
      ) : (
        <>
          <Button 
            variant="outline" 
            className={`${isAuthenticating ? 'bg-yellow-500' : 'bg-red-500'} text-white hover:bg-red-600 w-full`}
            onClick={handleConnect}
            disabled={isAuthenticating}
          >
            <Youtube className="mr-2 h-4 w-4" />
            {isAuthenticating ? 'Authenticating...' : 'Log in with YouTube'}
          </Button>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        {isAuthorized 
          ? "Authorized with YouTube. You can now connect to live streams." 
          : authError 
            ? `Auth error: ${authError}. Try again.`
            : "Authorize with YouTube to connect to your live streams."}
      </p>
    </div>
  );
};

export default YouTubeOAuthButton;
