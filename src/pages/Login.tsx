import React, { useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Twitch, Youtube, Heart } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import TwitchOAuthButton from '@/components/TwitchOAuthButton';
import YouTubeOAuthButton from '@/components/YouTubeOAuthButton';
import { useAuthStore } from '@/stores/authStore';

const Login = () => {
  // Auth state lives in the authStore (hydrated from the OS keychain at app
  // startup and updated by the OAuth callbacks). Keeping it in the store is
  // what lets ProtectedRoute admit the user right after a fresh login.
  const isTwitchAuthed = useAuthStore(s => s.isTwitchAuthed);
  const isYoutubeAuthed = useAuthStore(s => s.isYoutubeAuthed);
  const setTwitchAuth = useAuthStore(s => s.setTwitchAuth);
  const setYoutubeAuth = useAuthStore(s => s.setYoutubeAuth);
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
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground mb-4">
                    Authorize to read chat messages from your channel
                  </p>
                  <TwitchOAuthButton onAuthChange={setTwitchAuth} />
                </CardContent>
              </Card>
            </TabsContent>
            
            <TabsContent value="youtube">
              <Card className="border-red-500/30 bg-card/50 backdrop-blur-sm">
                <CardHeader className="flex flex-row items-center space-x-4 border-b border-border/40 pb-4">
                  <Youtube className="h-8 w-8 text-red-400" />
                  <CardTitle>Connect with YouTube</CardTitle>
                </CardHeader>
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground mb-4">
                    Authorize to read live chat from your streams
                  </p>
                  <YouTubeOAuthButton onAuthChange={setYoutubeAuth} />
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
