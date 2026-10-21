import { toast } from '@/hooks/use-toast';
import { useChatStore } from '@/stores/chatStore';
import { ttsQueueService } from '@/services/ttsQueueService';
import { stripCommandPrefix } from '@/services/ttsFilter';
import type { Message } from '@/types/message';

const ERROR_TOAST_INTERVAL_MS = 30_000;
let lastErrorToast = 0;

/** One toast per burst of failures, e.g. an invalid ElevenLabs key. */
const reportSpeechError = (detail?: string): void => {
  const now = Date.now();
  if (now - lastErrorToast < ERROR_TOAST_INTERVAL_MS) return;
  lastErrorToast = now;
  toast({ title: "Couldn't read a message aloud", description: detail, variant: 'destructive' });
};

/** Speaks a `!г` message and tracks its progress on the message. */
export function speakChatMessage(message: Message): void {
  const { updateMessageStatus } = useChatStore.getState();

  const text = stripCommandPrefix(message.content).trim();
  if (!text) {
    updateMessageStatus(message.id, 'skipped', 'Nothing to read');
    return;
  }

  updateMessageStatus(message.id, 'queued');
  ttsQueueService.enqueue({
    id: message.id,
    text,
    onStatus: (status, detail) => {
      useChatStore.getState().updateMessageStatus(message.id, status, detail);
      if (status === 'error') reportSpeechError(detail);
    },
  });
}
