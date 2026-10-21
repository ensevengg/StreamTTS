import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Twitch, Youtube, CheckCircle } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useChatStore } from '@/stores/chatStore';
import type { ChatConnection } from '@/types/chatSource';

const PlatformStatus: React.FC<{
  label: string;
  icon: React.ReactNode;
  isAuthed: boolean;
  connection?: ChatConnection;
}> = ({ label, icon, isAuthed, connection }) => {
  let badge: React.ReactNode;
  if (!isAuthed) {
    badge = <Badge variant="outline" className="bg-yellow-500/10 text-yellow-400 border-yellow-400/30">Not logged in</Badge>;
  } else if (connection?.status === 'connected') {
    badge = (
      <Badge className="bg-green-500/20 text-green-400 border-green-400/30 gap-1">
        <CheckCircle size={14} />
        <span>Connected</span>
      </Badge>
    );
  } else if (connection?.status === 'reconnecting' || connection?.status === 'connecting') {
    badge = <Badge variant="outline" className="bg-orange-500/10 text-orange-400 border-orange-400/30">Reconnecting…</Badge>;
  } else if (connection?.status === 'waiting') {
    badge = <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-400/30">Waiting for stream</Badge>;
  } else if (connection?.status === 'error') {
    badge = <Badge variant="destructive">Stopped</Badge>;
  } else {
    badge = <Badge variant="outline" className="bg-blue-500/10 text-blue-400 border-blue-400/30">Logged in</Badge>;
  }

  return (
    <div className="flex items-center gap-2" title={connection?.detail ?? connection?.channelName ?? ''}>
      {icon}
      <span className="text-sm">{label}:</span>
      {badge}
    </div>
  );
};

const ConnectionStatusPanel: React.FC = () => {
  const isTwitchAuthed = useAuthStore(s => s.isTwitchAuthed);
  const isYoutubeAuthed = useAuthStore(s => s.isYoutubeAuthed);
  const connections = useChatStore(s => s.connections);

  return (
    <Card className="bg-card/50 backdrop-blur-sm border-stream-accent/30 mb-4">
      <CardContent className="py-3 px-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-sm font-medium">Connection Status</h2>
          <div className="flex items-center gap-4">
            <PlatformStatus
              label="Twitch"
              icon={<Twitch size={18} className="text-purple-400" />}
              isAuthed={isTwitchAuthed}
              connection={connections.find(c => c.id === 'twitch')}
            />
            <PlatformStatus
              label="YouTube"
              icon={<Youtube size={18} className="text-red-400" />}
              isAuthed={isYoutubeAuthed}
              connection={connections.find(c => c.id === 'youtube')}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default ConnectionStatusPanel;
