import React, { useMemo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card } from '@/components/ui/card';
import { Volume2, User } from 'lucide-react';
import { Message } from '@/types/message';
import { TTS_COMMAND_PREFIX } from '@/config/constants';
import { useChatStore } from '@/stores/chatStore';

const MAX_VISIBLE_MESSAGES = 100;

const COMMAND_PREFIX_PATTERN = new RegExp(`^${TTS_COMMAND_PREFIX}\\s*`, 'i');

const stripCommandPrefix = (content: string): string =>
  content.replace(COMMAND_PREFIX_PATTERN, '');

interface MessageRowProps {
  message: Message;
}

// Memoized so an incoming message renders only the new row, and a status
// change (pending -> playing -> completed) re-renders only its own row.
const MessageRow = React.memo<MessageRowProps>(({ message }) => (
  <div
    className={`p-3 rounded-lg ${
      message.status === 'playing'
        ? 'bg-stream-accent/20 border border-stream-accent animate-pulse-glow'
        : 'bg-muted/30'
    }`}
  >
    <div className="flex items-center gap-2 mb-1">
      <User size={16} className="text-stream-accent" />
      <span className="text-sm font-semibold text-stream-accent">
        {message.username || 'Viewer'}
      </span>
      <span className="text-xs text-muted-foreground ml-auto">
        {new Date(message.timestamp).toLocaleTimeString()}
      </span>
    </div>
    <p className="text-sm ml-6">{stripCommandPrefix(message.content)}</p>
  </div>
));
MessageRow.displayName = 'MessageRow';

// Subscribes to the chat store directly so incoming messages never re-render
// anything above this component (Index, tabs, input, volume control).
const MessageHistory: React.FC = () => {
  const messages = useChatStore(s => s.messages);

  const visibleMessages = useMemo(() => {
    return messages.slice(-MAX_VISIBLE_MESSAGES);
  }, [messages]);

  return (
    <Card className="bg-card/50 backdrop-blur-sm border-stream-accent/30 w-full h-[400px]">
      <ScrollArea className="h-full p-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Volume2 size={40} className="mb-2 text-stream-accent/50" />
                            <p>No messages yet. Send a Russian message to get started!</p>
                            <p className="mt-2 text-sm">Example: {TTS_COMMAND_PREFIX} Привет, как дела?</p>
          </div>
        ) : (
          <div className="space-y-4">
            {visibleMessages.map((message) => (
              <MessageRow key={message.id} message={message} />
            ))}
            {messages.length > MAX_VISIBLE_MESSAGES && (
              <p className="text-xs text-muted-foreground text-center">
                Showing last {MAX_VISIBLE_MESSAGES} of {messages.length} messages
              </p>
            )}
          </div>
        )}
      </ScrollArea>
    </Card>
  );
};

export default MessageHistory;
