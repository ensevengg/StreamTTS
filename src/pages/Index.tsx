import { useEffect, lazy, Suspense, useCallback, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Mic, MessageSquare, Settings, Radio, Heart, Info, ChevronDown, ChevronRight, SkipForward, ListX } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

// Lazy load components with prefetch to avoid UI jank
const MessageInput = lazy(() => import('@/components/MessageInput'));
const MessageHistory = lazy(() => import('@/components/MessageHistory'));
const VolumeControl = lazy(() => import('@/components/VolumeControl'));
const ApiKeyInput = lazy(() => import('@/components/ApiKeyInput'));
const ChatConnections = lazy(() => import('@/components/ChatConnections'));
const ConnectionStatusPanel = lazy(() => import('@/components/ConnectionStatusPanel'));
const AlertSettings = lazy(() => import('@/components/AlertSettings'));

import { Message } from '@/types/message';
import { TTS_COMMAND_PREFIX } from '@/config/constants';
import { getAvailableBrowserVoices } from '@/services/ttsService';
import { ttsQueueService } from '@/services/ttsQueueService';
import { speakChatMessage } from '@/services/chatSpeech';
import { useChatStore } from '@/stores/chatStore';
import {
  useSettingsStore,
  TTSProvider,
  TTS_COOLDOWN_RANGE_SEC,
  TTS_MAX_LENGTH_RANGE,
} from '@/stores/settingsStore';

const Index = () => {
  const { toast } = useToast();
  const [isHowToUseOpen, setIsHowToUseOpen] = useState<boolean>(false);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [ttsInitialized, setTtsInitialized] = useState<boolean>(false);

  const activeTab = useChatStore(s => s.activeTab);
  const isProcessing = useChatStore(s => s.isProcessing);
  const addMessage = useChatStore(s => s.addMessage);
  const setActiveTab = useChatStore(s => s.setActiveTab);

  const apiKey = useSettingsStore(s => s.apiKey);
  const volume = useSettingsStore(s => s.volume);
  const ttsProvider = useSettingsStore(s => s.ttsProvider);
  const selectedVoice = useSettingsStore(s => s.selectedVoice);
  const setApiKey = useSettingsStore(s => s.setApiKey);
  const setVolume = useSettingsStore(s => s.setVolume);
  const setTtsProvider = useSettingsStore(s => s.setTtsProvider);
  const setSelectedVoice = useSettingsStore(s => s.setSelectedVoice);
  const ttsMaxLength = useSettingsStore(s => s.ttsMaxLength);
  const ttsViewerCooldownSec = useSettingsStore(s => s.ttsViewerCooldownSec);
  const setTtsMaxLength = useSettingsStore(s => s.setTtsMaxLength);
  const setTtsViewerCooldownSec = useSettingsStore(s => s.setTtsViewerCooldownSec);

  useEffect(() => {
    if (activeTab === 'chat' && !ttsInitialized) {
      const loadVoices = () => {
        const voices = getAvailableBrowserVoices();
        setAvailableVoices(voices);
        
        if (!selectedVoice) {
          const pavelVoice = voices.find(v => 
            v.name.includes('Pavel') || 
            v.name.includes('Microsoft Pavel')
          );
          
          if (pavelVoice) {
            setSelectedVoice(pavelVoice.name);
          } else {
            const russianVoice = voices.find(v => 
              v.lang.startsWith('ru') || 
              v.name.includes('Russian') || 
              v.name.includes('русский')
            );
            
            if (russianVoice) {
              setSelectedVoice(russianVoice.name);
            }
          }
        }
        
        setTtsInitialized(true);
      };
      
      if ('speechSynthesis' in window) {
        if (window.speechSynthesis.getVoices().length === 0) {
          const handleVoicesChanged = () => {
            loadVoices();
            window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged);
          };
          window.speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged);
          
          return () => {
            window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged);
          };
        } else {
          loadVoices();
        }
      }
    }
  }, [activeTab, ttsInitialized, selectedVoice, setSelectedVoice]);

  const handleApiKeySubmit = useCallback((key: string) => {
    setApiKey(key);
    toast({
      id: 'api-key-saved',
      title: "API Key Saved",
      description: "Your ElevenLabs API key has been saved"
    });
  }, [setApiKey, toast]);

  const handleVolumeChange = useCallback((value: number) => {
    setVolume(value);
  }, [setVolume]);

  const handleProviderChange = useCallback((checked: boolean) => {
    const newProvider: TTSProvider = checked ? 'elevenlabs' : 'browser';
    setTtsProvider(newProvider);
    
    toast({
      id: 'tts-provider-changed',
      title: `Switched to ${newProvider === 'browser' ? 'Browser TTS' : 'ElevenLabs'}`,
      description: newProvider === 'elevenlabs' 
        ? "Using ElevenLabs for TTS (requires API key)" 
        : "Using browser's built-in TTS (unlimited usage)"
    });
  }, [setTtsProvider, toast]);

  const handleVoiceChange = useCallback((voice: string) => {
    setSelectedVoice(voice);
  }, [setSelectedVoice]);

  const handleSendMessage = useCallback((content: string) => {
    const newMessage: Message = {
      id: `manual-${crypto.randomUUID()}`,
      content,
      timestamp: Date.now(),
      username: 'You',
    };

    addMessage(newMessage);
    speakChatMessage(newMessage, { fromViewer: false });
  }, [addMessage]);

  return (
    <div className="min-h-screen p-4 md:p-8 bg-stream-bg flex flex-col">
      <div className="max-w-4xl mx-auto w-full flex-1 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
                <span className="bg-gradient-to-r from-stream-accent to-stream-highlight bg-clip-text text-transparent">
                  StreamTTS
                </span>
              </h1>
              <p className="text-muted-foreground mt-1">
                Free TTS for streaming chat messages in your stream
              </p>
          </div>
          
          <Badge 
            variant="outline" 
            className={`${isProcessing ? 'bg-stream-highlight/20 text-stream-highlight border-stream-highlight/40 animate-pulse' : 'bg-muted/30'}`}
          >
            {isProcessing ? 'Speaking' : 'Ready'}
          </Badge>
        </div>

        {/* Connection Status Panel */}
        <Suspense fallback={<div className="h-12 mb-4 bg-card/50 backdrop-blur-sm border border-stream-accent/30 rounded-lg animate-pulse"></div>}>
          <ConnectionStatusPanel />
        </Suspense>
        
        {/* Main Content - More rectangular shape */}
        <Card className="border-stream-accent/30 bg-card/50 backdrop-blur-sm overflow-hidden flex-1 flex flex-col">
          <Tabs defaultValue="chat" value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
            <CardHeader className="pb-0">
              <TabsList className="grid grid-cols-3 bg-muted/30">
                <TabsTrigger value="chat" className="data-[state=active]:bg-stream-accent data-[state=active]:text-white">
                  <MessageSquare className="h-4 w-4 mr-2" />
                  Chat
                </TabsTrigger>
                <TabsTrigger value="connections" className="data-[state=active]:bg-stream-accent data-[state=active]:text-white">
                  <Radio className="h-4 w-4 mr-2" />
                  Connections
                </TabsTrigger>
                <TabsTrigger value="settings" className="data-[state=active]:bg-stream-accent data-[state=active]:text-white">
                  <Settings className="h-4 w-4 mr-2" />
                  Settings
                </TabsTrigger>
              </TabsList>
            </CardHeader>
            
            <CardContent className="pt-6 flex-1 flex flex-col">
              <Suspense fallback={<div className="p-4">Loading...</div>}>
                <TabsContent value="chat" className="space-y-4 flex-1 flex flex-col">
                  <div className="flex-1 overflow-y-auto">
                    <MessageHistory />
                  </div>
                  
                  <div className="flex flex-wrap items-center justify-center gap-3 my-4">
                    <VolumeControl volume={volume} onVolumeChange={handleVolumeChange} />
                    <Button variant="outline" size="sm" onClick={() => ttsQueueService.skip()} disabled={!isProcessing}>
                      <SkipForward className="h-4 w-4 mr-1" />
                      Skip
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => ttsQueueService.clear()} disabled={!isProcessing}>
                      <ListX className="h-4 w-4 mr-1" />
                      Clear queue
                    </Button>
                  </div>
                  
                  <MessageInput onSendMessage={handleSendMessage} ttsProvider={ttsProvider} />
                </TabsContent>
                
                <TabsContent value="connections" className="space-y-4 flex-1 flex flex-col">
                  <div className="flex-1">
                    <ChatConnections />
                  </div>
                </TabsContent>
                
                <TabsContent value="settings" className="flex-1 flex flex-col">
                  <div className="space-y-6 flex-1">
                    <Suspense fallback={<div className="h-48 bg-card/50 rounded-lg animate-pulse"></div>}>
                      <AlertSettings />
                    </Suspense>
                    
                    <div className="flex items-center justify-between rounded-lg border p-4">
                      <div className="space-y-0.5">
                        <h4 className="font-medium">TTS Provider</h4>
                        <p className="text-sm text-muted-foreground">
                          Browser TTS (free) or ElevenLabs (premium)
                        </p>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Label htmlFor="tts-provider">Browser</Label>
                        <Switch 
                          id="tts-provider" 
                          checked={ttsProvider === 'elevenlabs'}
                          onCheckedChange={handleProviderChange}
                        />
                        <Label htmlFor="tts-provider">ElevenLabs</Label>
                      </div>
                    </div>
                    
                    {ttsProvider === 'browser' && (
                      <div className="rounded-lg border p-4">
                        <h4 className="font-medium mb-2">Voice Selection</h4>
                        <Select value={selectedVoice} onValueChange={handleVoiceChange}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select a voice" />
                          </SelectTrigger>
                          <SelectContent>
                            {availableVoices.map((voice) => (
                              <SelectItem 
                                key={voice.name} 
                                value={voice.name}
                              >
                                {voice.name} {voice.lang ? `(${voice.lang})` : ''}
                                {voice.lang && voice.lang.startsWith('ru') && ' - Recommended'}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    
                    <div className="rounded-lg border p-4 space-y-4">
                      <div>
                        <h4 className="font-medium">Viewer Limits</h4>
                        <p className="text-sm text-muted-foreground">
                          Keep one viewer from taking over the voice. Links are read as "link".
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="tts-max-length">Longest message read: {ttsMaxLength} characters</Label>
                        <Slider
                          id="tts-max-length"
                          min={TTS_MAX_LENGTH_RANGE.min}
                          max={TTS_MAX_LENGTH_RANGE.max}
                          step={10}
                          value={[ttsMaxLength]}
                          onValueChange={([value]) => setTtsMaxLength(value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="tts-cooldown">
                          Cooldown per viewer: {ttsViewerCooldownSec === 0 ? 'off' : `${ttsViewerCooldownSec}s`}
                        </Label>
                        <Slider
                          id="tts-cooldown"
                          min={TTS_COOLDOWN_RANGE_SEC.min}
                          max={TTS_COOLDOWN_RANGE_SEC.max}
                          step={5}
                          value={[ttsViewerCooldownSec]}
                          onValueChange={([value]) => setTtsViewerCooldownSec(value)}
                        />
                      </div>
                    </div>

                    {ttsProvider === 'elevenlabs' && (
                      <div className="grid place-items-center">
                        <ApiKeyInput 
                          onApiKeySubmit={handleApiKeySubmit} 
                          apiKeySet={!!apiKey} 
                        />
                      </div>
                    )}
                    
                    <Collapsible open={isHowToUseOpen} onOpenChange={setIsHowToUseOpen}>
                      <Card className="bg-muted/20 border-stream-accent/20">
                        <CollapsibleTrigger asChild>
                          <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors">
                            <CardTitle className="text-lg flex items-center gap-2">
                              {isHowToUseOpen ? <ChevronDown size={18} className="text-stream-accent" /> : <ChevronRight size={18} className="text-stream-accent" />}
                              <Mic size={18} className="text-stream-accent" />
                              How to Use
                            </CardTitle>
                          </CardHeader>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <CardContent className="space-y-3 text-sm">
                            <p>
                              <span className="text-stream-accent font-semibold">1.</span> {ttsProvider === 'elevenlabs' ? 'Set your ElevenLabs API key above' : 'Select a voice from the dropdown above'}
                            </p>
                            <p>
                              <span className="text-stream-accent font-semibold">2.</span> Go to Connections and connect to Twitch or YouTube
                            </p>
                            <p>
                              <span className="text-stream-accent font-semibold">3.</span> Messages starting with <code className="bg-muted px-1 rounded text-stream-accent">{TTS_COMMAND_PREFIX}</code> will be read aloud
                            </p>
                            <p className="text-muted-foreground italic mt-4">
                              Example: <code className="bg-muted px-1 rounded text-stream-accent">{TTS_COMMAND_PREFIX} Привет!</code>
                            </p>
                          </CardContent>
                        </CollapsibleContent>
                      </Card>
                    </Collapsible>
                    
                    <Alert className="bg-yellow-500/10 border-yellow-500/50">
                      <Info className="h-4 w-4 text-yellow-500" />
                      <AlertTitle>Privacy</AlertTitle>
                      <AlertDescription>
                        Your logins and API key are stored in your system's keychain on this computer. They are only
                        sent to the service they belong to (Twitch, Google or ElevenLabs).
                      </AlertDescription>
                    </Alert>
                  </div>
                </TabsContent>
              </Suspense>
            </CardContent>
          </Tabs>
          
          <div className="p-4 text-center text-xs text-muted-foreground border-t border-stream-accent/10">
            Made with <Heart className="inline h-3 w-3 text-red-500 mx-1" /> Nerve © 2025
          </div>
        </Card>
      </div>
    </div>
  );
};

export default Index;
