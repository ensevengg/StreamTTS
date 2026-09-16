import React from 'react';
import { Button } from '@/components/ui/button';
import { Twitch, CheckCircle, AlertCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { saveTwitchOAuthToken, hasTwitchOAuthToken, clearTwitchOAuthToken, validateTwitchToken, isTwitchTokenStale, refreshTwitchToken, getTwitchTokenInfo } from '@/services/twitchService';
import { openExternalAuth, onAuthCallback, type AuthCallbackData, isTauriAvailable } from '@/lib/tauri-api';
import { buildTwitchAuthUrl, prepareOAuthState } from '@/lib/oauth-utils';

interface TwitchOAuthButtonProps {
  onAuthChange: (isAuthed: boolean) => void;
}

const TwitchOAuthButton: React.FC<TwitchOAuthButtonProps> = ({ onAuthChange }) => {
  const { toast } = useToast();
  const [isAuthorized, setIsAuthorized] = React.useState<boolean>(false);
  const [isAuthenticating, setIsAuthenticating] = React.useState<boolean>(false);
  const [tokenStatus, setTokenStatus] = React.useState<'valid' | 'stale' | 'invalid' | 'checking'>('valid');
  const pendingStateRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const validateToken = async () => {
      const info = await getTwitchTokenInfo();
      if (!info?.token) {
        return;
      }

      setTokenStatus('checking');

      // Authorization-code tokens are short-lived; refresh proactively when
      // the stored one is at or near expiry.
      if (await isTwitchTokenStale()) {
        await refreshTwitchToken();
      }

      const result = await validateTwitchToken();

      if (result.valid) {
        const stillStale = await isTwitchTokenStale();
        setTokenStatus(stillStale ? 'stale' : 'valid');
      } else {
        console.log("TwitchService: Token validation failed:", result.error);
        setTokenStatus('invalid');
        await clearTwitchOAuthToken();
        setIsAuthorized(false);
        onAuthChange(false);

        toast({
          title: "Twitch Session Expired",
          description: "Your Twitch authentication has expired. Please reconnect.",
          variant: "destructive"
        });
      }
    };

    validateToken();

    const intervalId = setInterval(validateToken, 5 * 60 * 1000);

    return () => clearInterval(intervalId);
  }, [onAuthChange, toast]);

  React.useEffect(() => {
    const syncTokenState = async () => {
      const hasToken = await hasTwitchOAuthToken();
      if (hasToken !== isAuthorized) {
        setIsAuthorized(hasToken);
        onAuthChange(hasToken);
      }
      if (hasToken && await isTwitchTokenStale()) {
        setTokenStatus((current) => (current === 'valid' ? 'stale' : current));
      }
    };

    void syncTokenState();

    window.addEventListener('storage', syncTokenState);
    return () => window.removeEventListener('storage', syncTokenState);
  }, [isAuthorized, onAuthChange]);

  React.useEffect(() => {
    const unlistenAuth = onAuthCallback((data: AuthCallbackData) => {
      if (data.type !== 'twitch-oauth-callback') return;

      if (pendingStateRef.current && data.state !== pendingStateRef.current) {
        console.error('TwitchOAuthButton: OAuth state mismatch - possible CSRF attack');
        setIsAuthenticating(false);
        toast({
          title: "Security Error",
          description: "OAuth state validation failed. Please try again.",
          variant: "destructive"
        });
        return;
      }

      if (data.token) {
        pendingStateRef.current = null;
        void saveTwitchOAuthToken(data.token, data.refresh_token, data.expires_in).then(() => {
          setIsAuthorized(true);
          onAuthChange(true);
          setIsAuthenticating(false);

          toast({
            title: "Twitch Authentication Successful",
            description: "You can now connect to your Twitch channels"
          });
        });
      } else if (data.error) {
        pendingStateRef.current = null;
        console.error("Auth error from Tauri:", data.error);
        setIsAuthenticating(false);

        toast({
          title: "Authentication Failed",
          description: `Twitch error: ${data.error}`,
          variant: "destructive"
        });
      }
    });

    return () => {
      unlistenAuth();
    };
  }, [onAuthChange, toast]);

  const handleConnect = async () => {
    setIsAuthenticating(true);

    if (isTauriAvailable()) {
      try {
        const { url, state, codeVerifier } = await buildTwitchAuthUrl();
        pendingStateRef.current = state;
        // Register the state (and PKCE verifier) with the backend before the
        // browser flow starts, so the loopback callback can consume it once.
        await prepareOAuthState('twitch', state, codeVerifier);
        await openExternalAuth(url);
      } catch (error) {
        pendingStateRef.current = null;
        console.error("Twitch Auth: Error opening auth URL:", error);
        setIsAuthenticating(false);

        toast({
          title: "Authentication Error",
          description: "Failed to open Twitch authentication page",
          variant: "destructive"
        });
      }
    } else {
      try {
        const { url, state } = await buildTwitchAuthUrl();
        pendingStateRef.current = state;
        window.location.href = url;
      } catch (error) {
        console.error("Twitch Auth: Failed to build auth URL:", error);
        setIsAuthenticating(false);
      }
    }
  };

  const handleDisconnect = async () => {
    await clearTwitchOAuthToken();
    setIsAuthorized(false);
    onAuthChange(false);

    toast({
      title: "Twitch Disconnected",
      description: "You've been logged out of Twitch"
    });
  };

  return (
    <div className="flex flex-col space-y-2">
      {isAuthorized ? (
        <>
          <Button
            variant="outline"
            className={`text-white w-full ${
              tokenStatus === 'invalid' ? 'bg-red-500 hover:bg-red-600' :
              tokenStatus === 'stale' ? 'bg-yellow-500 hover:bg-yellow-600' :
              'bg-green-500 hover:bg-purple-600'
            }`}
            onClick={handleDisconnect}
          >
            {tokenStatus === 'invalid' || tokenStatus === 'stale' ? (
              <AlertCircle className="mr-2 h-4 w-4" />
            ) : (
              <CheckCircle className="mr-2 h-4 w-4" />
            )}
            {tokenStatus === 'checking' ? 'Verifying...' :
             tokenStatus === 'invalid' ? 'Session Expired' :
             tokenStatus === 'stale' ? 'Reconnect Recommended' :
             'Connected to Twitch'}
          </Button>
          {(tokenStatus === 'stale' || tokenStatus === 'invalid') && (
            <Button
              variant="outline"
              className="bg-purple-500 text-white hover:bg-purple-600 w-full"
              onClick={handleConnect}
              disabled={isAuthenticating}
            >
              <Twitch className="mr-2 h-4 w-4" />
              {isAuthenticating ? 'Reconnecting...' : 'Reconnect Twitch'}
            </Button>
          )}
        </>
      ) : (
        <Button
          variant="outline"
          className={`${isAuthenticating ? 'bg-yellow-500' : 'bg-purple-500'} text-white hover:bg-purple-600 w-full`}
          onClick={handleConnect}
          disabled={isAuthenticating}
        >
          <Twitch className="mr-2 h-4 w-4" />
          {isAuthenticating ? 'Authenticating...' : 'Log in with Twitch'}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        {isAuthorized
          ? tokenStatus === 'stale'
            ? "Token may be stale. Consider reconnecting for best reliability."
            : tokenStatus === 'invalid'
              ? "Your session has expired. Please reconnect."
              : "Authorized with Twitch. You can now connect to channels."
          : "Authorize with Twitch to connect to chat channels."}
      </p>
    </div>
  );
};

export default TwitchOAuthButton;
