import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Twitch, Youtube, CheckCircle, LogOut, PlugIcon, Power } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { errorMessage } from '@/lib/http';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import {
  connectTwitch,
  connectYoutube,
  disconnectTwitch,
  disconnectYoutube,
  signOutTwitch,
  signOutYoutube,
} from '@/services/chatSessions';
import type { ChatConnection, ConnectionStatus } from '@/types/chatSource';
import TwitchOAuthButton from '@/components/TwitchOAuthButton';
import YouTubeOAuthButton from '@/components/YouTubeOAuthButton';
import DiagnoseYouTube from '@/components/DiagnoseYouTube';

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  waiting: 'Waiting for stream',
  error: 'Stopped',
};

const STATUS_VARIANTS: Record<ConnectionStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  connecting: 'secondary',
  connected: 'default',
  reconnecting: 'outline',
  waiting: 'outline',
  error: 'destructive',
};

interface PlatformCardProps {
  title: string;
  icon: React.ReactNode;
  accent: string;
  isAuthed: boolean;
  connection?: ChatConnection;
  loginButton: React.ReactNode;
  extraActions?: React.ReactNode;
  onConnect: () => Promise<void> | void;
  onDisconnect: () => void;
  onLogout: () => Promise<void>;
}

const PlatformCard: React.FC<PlatformCardProps> = ({
  title, icon, accent, isAuthed, connection, loginButton, extraActions, onConnect, onDisconnect, onLogout,
}) => {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  // A stopped session can be restarted; a running one is already retrying.
  const active = !!connection && connection.status !== 'error';

  const connect = async () => {
    setBusy(true);
    try {
      await onConnect();
    } catch (error) {
      toast({ title: `Couldn't connect to ${title}`, description: errorMessage(error), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className={accent}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon}
          {title}
          {isAuthed && (
            <Badge variant="outline" className="bg-green-500/20 text-green-400 border-green-500/50">
              <CheckCircle className="h-3 w-3 mr-1" />
              Logged in
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!isAuthed ? (
          loginButton
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button onClick={connect} disabled={busy || active}>
              <PlugIcon className="h-4 w-4 mr-2" />
              {busy ? 'Connecting…' : active ? 'Connected' : connection ? 'Reconnect' : 'Connect to chat'}
            </Button>
            {connection && (
              <Button onClick={onDisconnect} variant="outline" className="border-red-500/50 text-red-400 hover:bg-red-500/20">
                <Power className="h-4 w-4 mr-2" />
                Disconnect
              </Button>
            )}
            <Button onClick={() => void onLogout()} variant="outline" className="border-gray-500/50 text-gray-400 hover:bg-gray-500/20">
              <LogOut className="h-4 w-4 mr-2" />
              Log out
            </Button>
            {extraActions}
          </div>
        )}

        {connection && (
          <div className="p-3 border rounded-lg space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{connection.channelName}</span>
              <Badge variant={STATUS_VARIANTS[connection.status]} className="ml-auto shrink-0">
                {STATUS_LABELS[connection.status]}
              </Badge>
            </div>
            {connection.detail && <p className="text-xs text-muted-foreground">{connection.detail}</p>}
            {connection.alertsDetail && <p className="text-xs text-muted-foreground">{connection.alertsDetail}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

const ChatConnections: React.FC = () => {
  const connections = useChatStore(s => s.connections);
  const isTwitchAuthed = useAuthStore(s => s.isTwitchAuthed);
  const isYoutubeAuthed = useAuthStore(s => s.isYoutubeAuthed);
  const setTwitchAuth = useAuthStore(s => s.setTwitchAuth);
  const setYoutubeAuth = useAuthStore(s => s.setYoutubeAuth);
  const live = connections.filter(c => c.status === 'connected').length;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Chat Connections</h2>
        <Badge variant="outline" className="text-xs">{live} connected</Badge>
      </div>

      <PlatformCard
        title="Twitch"
        icon={<Twitch className="h-5 w-5 text-purple-500" />}
        accent="border-purple-500/30"
        isAuthed={isTwitchAuthed}
        connection={connections.find(c => c.id === 'twitch')}
        loginButton={<TwitchOAuthButton onAuthChange={setTwitchAuth} />}
        onConnect={connectTwitch}
        onDisconnect={disconnectTwitch}
        onLogout={signOutTwitch}
      />

      <PlatformCard
        title="YouTube"
        icon={<Youtube className="h-5 w-5 text-red-500" />}
        accent="border-red-500/30"
        isAuthed={isYoutubeAuthed}
        connection={connections.find(c => c.id === 'youtube')}
        loginButton={<YouTubeOAuthButton onAuthChange={setYoutubeAuth} />}
        extraActions={<DiagnoseYouTube />}
        onConnect={connectYoutube}
        onDisconnect={disconnectYoutube}
        onLogout={signOutYoutube}
      />
    </div>
  );
};

export default ChatConnections;
