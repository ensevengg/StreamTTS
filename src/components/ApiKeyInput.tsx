import React, { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Key, Eye, EyeOff, Check } from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

interface ApiKeyInputProps {
  onApiKeySubmit: (apiKey: string) => void;
  onApiKeyRemove: () => void;
  apiKeySet: boolean;
}

const ApiKeyInput: React.FC<ApiKeyInputProps> = ({ onApiKeySubmit, onApiKeyRemove, apiKeySet }) => {
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const editing = !apiKeySet || replacing;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (apiKey.trim()) {
      onApiKeySubmit(apiKey.trim());
      setApiKey('');
      setReplacing(false);
    }
  };

  return (
    <Card className="w-full max-w-md bg-card/50 backdrop-blur-sm border-stream-accent/30">
      <CardHeader>
        <CardTitle className="text-xl flex items-center gap-2">
          <Key size={20} className="text-stream-accent" />
          ElevenLabs API Key
        </CardTitle>
        <CardDescription>
          Enter your ElevenLabs API key to use its voices (Russian and English)
        </CardDescription>
      </CardHeader>

      <form onSubmit={handleSubmit}>
        <CardContent>
          {editing ? (
            <div className="relative">
              <Input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={apiKeySet ? 'Enter the new API key' : 'Enter your ElevenLabs API key'}
                className="pr-10 bg-muted border-stream-accent/30 focus:border-stream-accent"
                autoComplete="off"
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 transform -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowApiKey(!showApiKey)}
                aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
              >
                {showApiKey ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm">
              <Check size={18} className="text-stream-highlight" />
              An API key is saved in your system keychain.
            </p>
          )}

          <p className="mt-2 text-xs text-muted-foreground">
            Get your API key from <a
              href="https://elevenlabs.io/app"
              target="_blank"
              rel="noopener noreferrer"
              className="text-stream-accent hover:underline"
            >
              ElevenLabs
            </a>
          </p>
        </CardContent>

        <CardFooter className="gap-2">
          {editing ? (
            <>
              <Button
                type="submit"
                className="flex-1 bg-stream-accent hover:bg-stream-accent/80"
                disabled={!apiKey.trim()}
              >
                Save API Key
              </Button>
              {replacing && (
                <Button type="button" variant="ghost" onClick={() => { setReplacing(false); setApiKey(''); }}>
                  Cancel
                </Button>
              )}
            </>
          ) : (
            <>
              <Button type="button" variant="outline" className="flex-1" onClick={() => setReplacing(true)}>
                Replace key
              </Button>
              <Button type="button" variant="outline" className="border-red-500/50 text-red-400" onClick={onApiKeyRemove}>
                Remove key
              </Button>
            </>
          )}
        </CardFooter>
      </form>
    </Card>
  );
};

export default ApiKeyInput;
