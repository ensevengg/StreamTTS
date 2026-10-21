import React, { useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Twitch, Youtube, Heart } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import TwitchLoginButton from '@/components/TwitchLoginButton';
import YouTubeLoginButton from '@/components/YouTubeLoginButton';
import { useAuthStore } from '@/stores/authStore';

const Login = () => {
  // Auth state lives in the authStore (hydrated from the OS keychain at app
  // startup and updated by the app-wide auth callbacks). Keeping it in the
  // store is what lets ProtectedRoute admit the user right after a login.
  const isTwitchAuthed = useAuthStore(s => s.isTwitchAuthed);
  const isYoutubeAuthed = useAuthStore(s => s.isYoutubeAuthed);
  const navigate = useNavigate();

  useEffect(() => {
    if (isTwitchAuthed || isYoutubeAuthed) {
      navigate('/');
    }
  }, [isTwitchAuthed, isYoutubeAuthed, navigate]);

  return (
    <div className="min-h-screen p-4 md:p-8 bg-stream-bg flex flex-col">
      <div className="max-w-md mx-auto w-full flex-1 flex flex-col">
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold">
            <span className="bg-gradient-to-r from-stream-accent to-stream-highlight bg-clip-text text-transparent">
              StreamTTS
            </span>
          </h1>
          <p className="text-muted-foreground mt-2">
            Connect your streaming platform to get started
          </p>
        </div>

        <Tabs defaultValue="twitch" className="flex-1">
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="twitch" className="flex items-center gap-2">
              <Twitch className="h-4 w-4 text-purple-400" />
              Twitch
            </TabsTrigger>
            <TabsTrigger value="youtube" className="flex items-center gap-2">
              <Youtube className="h-4 w-4 text-red-400" />
              YouTube
            </TabsTrigger>
          </TabsList>

          <div className="mt-6">
            <TabsContent value="twitch">
              <Card className="border-purple-500/30 bg-card/50 backdrop-blur-sm">
                <CardHeader className="flex flex-row items-center space-x-4 border-b border-border/40 pb-4">
                  <Twitch className="h-8 w-8 text-purple-400" />
                  <CardTitle>Connect with Twitch</CardTitle>
                </CardHeader>
                <CardContent className="pt-6 space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Read-only access: StreamTTS can read your chat and see subs and channel-point
                    redemptions for alerts. It can't post, moderate or change your channel.
                  </p>
                  <TwitchLoginButton />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="youtube">
              <Card className="border-red-500/30 bg-card/50 backdrop-blur-sm">
                <CardHeader className="flex flex-row items-center space-x-4 border-b border-border/40 pb-4">
                  <Youtube className="h-8 w-8 text-red-400" />
                  <CardTitle>Connect with YouTube</CardTitle>
                </CardHeader>
                <CardContent className="pt-6 space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Read-only access: StreamTTS can read your live chat. It can't post, upload,
                    edit or delete anything on your channel.
                  </p>
                  <YouTubeLoginButton />
                </CardContent>
              </Card>
            </TabsContent>
          </div>
        </Tabs>

        <div className="pt-6 text-center text-xs text-muted-foreground mt-auto">
          Made with <Heart className="inline h-3 w-3 text-red-500 mx-1" /> Nerve © 2025
        </div>
      </div>
    </div>
  );
};

export default Login;
