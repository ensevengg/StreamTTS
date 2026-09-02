import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Twitch, Youtube, X, LogIn, CheckCircle, LogOut, PlugIcon, Power } from 'lucide-react';
import { ChatSource } from '@/types/chatSource';
import { useChatStore } from '@/stores/chatStore';
import { useTwitchConnection } from '@/hooks/useTwitchConnection';
import { useYoutubeConnection } from '@/hooks/useYoutubeConnection';
import DiagnoseYouTube from '@/components/DiagnoseYouTube';

const ChatConnections: React.FC = () => {
  const connections = useChatStore(s => s.connections);

  const twitch = useTwitchConnection();
  const youtube = useYoutubeConnection();

  const getSourceIcon = (source: ChatSource) => {
    switch (source) {
      case 'twitch':
        return <Twitch size={16} className="text-purple-400" />;
      case 'youtube':
        return <Youtube size={16} className="text-red-400" />;
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">Chat Connections</h2>
        <Badge variant="outline" className="text-xs">
          {connections.length} connected
        </Badge>
      </div>

      <Card className="border-purple-500/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Twitch className="h-5 w-5 text-purple-500" />
            Twitch
            {twitch.isTwitchAuthed && (
              <Badge variant="outline" className="bg-green-500/20 text-green-400 border-green-500/50">
                <CheckCircle className="h-3 w-3 mr-1" />
                Authenticated
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {!twitch.isTwitchAuthed ? (
              <Button onClick={twitch.startAuth} className="bg-purple-600 hover:bg-purple-700">
                <LogIn className="h-4 w-4 mr-2" />
                Login with Twitch
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button onClick={twitch.connect} disabled={twitch.isConnecting || twitch.isConnected} className="bg-purple-600 hover:bg-purple-700">
                  <PlugIcon className="h-4 w-4 mr-2" />
                  {twitch.isConnecting ? 'Connecting...' : twitch.isConnected ? 'Connected to Stream' : 'Connect to Stream'}
                </Button>
                {twitch.isConnected && (
                  <Button onClick={twitch.disconnectAll} variant="outline" className="border-red-500/50 text-red-400 hover:bg-red-500/20">
                    <Power className="h-4 w-4 mr-2" />
                    Disconnect
                  </Button>
                )}
                <Button onClick={twitch.handleLogout} variant="outline" className="border-gray-500/50 text-gray-400 hover:bg-gray-500/20">
                  <LogOut className="h-4 w-4 mr-2" />
                  Logout
                </Button>
              </div>
            )}
          </div>

          {connections.filter(c => c.type === 'twitch').map(connection => (
            <div key={connection.id} className="flex items-center justify-between p-3 border rounded-lg">
              <div className="flex items-center gap-2">
                <Twitch className="h-4 w-4 text-purple-500" />
                <span className="font-medium">{connection.channelName}</span>
                <Badge variant={connection.isConnected ? 'default' : 'secondary'}>
                  {connection.status === 'connecting' ? 'Connecting...' :
                   connection.status === 'connected' ? 'Connected' :
                   connection.status === 'error' ? 'Error' :
                   connection.status === 'reconnecting' ? 'Reconnecting...' : 'Disconnected'}
                </Badge>
              </div>
              <Button onClick={() => twitch.disconnectById(connection.id)} variant="ghost" size="sm">
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="border-red-500/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Youtube className="h-5 w-5 text-red-500" />
            YouTube
            {youtube.isYoutubeAuthed && (
              <Badge variant="outline" className="bg-green-500/20 text-green-400 border-green-500/50">
                <CheckCircle className="h-3 w-3 mr-1" />
                Authenticated
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {!youtube.isYoutubeAuthed ? (
              <Button onClick={youtube.startAuth} className="bg-red-600 hover:bg-red-700">
                <LogIn className="h-4 w-4 mr-2" />
                Login with YouTube
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button onClick={youtube.connect} disabled={youtube.isConnecting || youtube.isConnected} className="bg-red-600 hover:bg-red-700">
                  <PlugIcon className="h-4 w-4 mr-2" />
                  {youtube.isConnecting ? 'Connecting...' : youtube.isConnected ? 'Connected to Live Chat' : 'Connect to Live Chat'}
                </Button>
                {youtube.isConnected && (
                  <Button onClick={youtube.disconnectAll} variant="outline" className="border-red-500/50 text-red-400 hover:bg-red-500/20">
                    <Power className="h-4 w-4 mr-2" />
                    Disconnect
                  </Button>
                )}
                <Button onClick={youtube.handleLogout} variant="outline" className="border-gray-500/50 text-gray-400 hover:bg-gray-500/20">
                  <LogOut className="h-4 w-4 mr-2" />
                  Logout
                </Button>
                <DiagnoseYouTube />
                <Button onClick={youtube.resetAuth} variant="outline" className="border-gray-500/50 text-gray-400 hover:bg-gray-500/20">
                  Reset Auth
                </Button>
              </div>
            )}
          </div>

          {connections.filter(c => c.type === 'youtube').map(connection => (
            <div key={connection.id} className="flex items-center justify-between p-3 border rounded-lg">
              <div className="flex items-center gap-2">
                <Youtube className="h-4 w-4 text-red-500" />
                <span className="font-medium">{connection.channelName}</span>
                <Badge variant={connection.isConnected ? 'default' : 'secondary'}>
                  {connection.status === 'connecting' ? 'Connecting...' :
                   connection.status === 'connected' ? 'Connected' :
                   connection.status === 'error' ? 'Error' :
                   connection.status === 'reconnecting' ? 'Reconnecting...' : 'Disconnected'}
                </Badge>
              </div>
              <Button onClick={() => youtube.disconnectById(connection.id)} variant="ghost" size="sm">
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
};

export default ChatConnections;
