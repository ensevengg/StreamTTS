import { toast } from '@/hooks/use-toast';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { ttsQueueService } from '@/services/ttsQueueService';
import { CooldownTracker, prepareSpeechText, stripCommandPrefix } from '@/services/ttsFilter';
import type { Message } from '@/types/message';

const cooldowns = new CooldownTracker();
const ERROR_TOAST_INTERVAL_MS = 30_000;
let lastErrorToast = 0;

/** One toast per burst of failures, e.g. an invalid ElevenLabs key. */
const reportSpeechError = (detail?: string): void => {
  const now = Date.now();
  if (now - lastErrorToast < ERROR_TOAST_INTERVAL_MS) return;
  lastErrorToast = now;
  toast({ title: "Couldn't read a message aloud", description: detail, variant: 'destructive' });
};

/**
 * Speaks a `!г` message. Viewer messages are subject to the per-viewer
 * cooldown and queue cap; messages the streamer types are not.
 */
export function speakChatMessage(message: Message, { fromViewer }: { fromViewer: boolean }): void {
  const { ttsMaxLength, ttsViewerCooldownSec } = useSettingsStore.getState();
  const { updateMessageStatus } = useChatStore.getState();

  const text = prepareSpeechText(stripCommandPrefix(message.content), ttsMaxLength);
  if (!text) {
    updateMessageStatus(message.id, 'skipped', 'Nothing to read');
    return;
  }
  const viewer = (message.username || 'anonymous').toLowerCase();
  if (fromViewer && !cooldowns.allow(viewer, ttsViewerCooldownSec * 1000)) {
    updateMessageStatus(message.id, 'skipped', 'Viewer cooldown');
    return;
  }

  updateMessageStatus(message.id, 'queued');
  const accepted = ttsQueueService.enqueue({
    id: message.id,
    text,
    owner: fromViewer ? viewer : undefined,
    onStatus: (status, detail) => {
      useChatStore.getState().updateMessageStatus(message.id, status, detail);
      if (status === 'error') reportSpeechError(detail);
    },
  });
  if (!accepted) updateMessageStatus(message.id, 'skipped', 'Too many messages from this viewer');
}
