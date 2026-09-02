import { useCallback } from 'react';
import { ttsQueueService } from '@/services/ttsQueueService';
import { Message } from '@/types/message';

// Queue state (isProcessing) is mirrored into chatStore by the service, so
// components that need it subscribe there rather than to this hook.
export function useTtsQueue() {
  const enqueue = useCallback((message: Message) => {
    ttsQueueService.enqueue(message);
  }, []);

  return { enqueue };
}
