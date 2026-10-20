import React, { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Send, Volume2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { parseTtsCommand } from '@/services/ttsFilter';

interface MessageInputProps {
  onSendMessage: (message: string) => void;
  ttsProvider: 'browser' | 'elevenlabs';
}

const MessageInput: React.FC<MessageInputProps> = ({ onSendMessage, ttsProvider }) => {
  const [message, setMessage] = useState('');
  const { toast } = useToast();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!message.trim()) {
      return;
    }
    
    if (parseTtsCommand(message)?.text.trim()) {
      onSendMessage(message);
      setMessage('');
    } else {
      toast({
        title: "TTS command required",
        description: 'Start with !г (Russian) or !r (English) to have this message read aloud',
        variant: "destructive"
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex space-x-2 w-full">
      <div className="relative flex-1">
        <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-stream-accent">
          <Volume2 size={18} />
        </span>
        <Input 
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={`Start with !г or !r to read message aloud... (${ttsProvider === 'browser' ? 'Browser TTS' : 'ElevenLabs'})`}
          className="pl-10 bg-muted border-stream-accent/30 focus:border-stream-accent focus-visible:ring-stream-accent/50"
        />
      </div>
      <Button 
        type="submit" 
        className="bg-stream-accent hover:bg-stream-accent/80 text-white"
      >
        <Send size={18} />
      </Button>
    </form>
  );
};

export default MessageInput;
