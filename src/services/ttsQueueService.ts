import { speak, type SpeakOptions } from '@/services/ttsService';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { errorMessage } from '@/lib/http';

export type SpeechJobStatus = 'playing' | 'completed' | 'skipped' | 'error';

export interface SpeechJob {
  id: string;
  text: string;
  onStatus?: (status: SpeechJobStatus, detail?: string) => void;
}

export const MAX_QUEUE_LENGTH = 50;

interface QueueDeps {
  speak: (text: string, options: SpeakOptions) => Promise<void>;
  getSettings: () => Pick<SpeakOptions, 'provider' | 'apiKey' | 'volume' | 'voiceName'>;
  setProcessing: (processing: boolean) => void;
}

const defaultDeps: QueueDeps = {
  speak,
  getSettings: () => {
    const { ttsProvider, apiKey, volume, selectedVoice } = useSettingsStore.getState();
    return { provider: ttsProvider, apiKey, volume, voiceName: selectedVoice || undefined };
  },
  setProcessing: (processing) => useChatStore.getState().setIsProcessing(processing),
};

/** Plays one message at a time, in order. */
export class TtsQueue {
  private waiting: SpeechJob[] = [];
  private current: { job: SpeechJob; controller: AbortController } | null = null;
  private running = false;

  constructor(private readonly deps: QueueDeps = defaultDeps) {}

  enqueue(job: SpeechJob): void {
    if (this.waiting.length >= MAX_QUEUE_LENGTH) {
      // Drop the oldest waiting message. The job being spoken isn't in
      // `waiting`, so it is never the one dropped.
      const dropped = this.waiting.shift() as SpeechJob;
      dropped.onStatus?.('skipped', 'The queue was full');
    }
    this.waiting.push(job);
    void this.run();
  }

  /** Stops whatever is playing; the next job starts right away. */
  skip(): void {
    this.current?.controller.abort();
  }

  /** Drops everything waiting and stops what is playing. */
  clear(): void {
    const dropped = this.waiting;
    this.waiting = [];
    for (const job of dropped) job.onStatus?.('skipped', 'Queue cleared');
    this.skip();
  }

  get length(): number {
    return this.waiting.length;
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.deps.setProcessing(true);
    try {
      while (this.waiting.length > 0) {
        const job = this.waiting.shift() as SpeechJob;
        const controller = new AbortController();
        this.current = { job, controller };
        job.onStatus?.('playing');
        const settings = this.deps.getSettings();
        try {
          await this.deps.speak(job.text, { ...settings, signal: controller.signal });
          job.onStatus?.('completed');
        } catch (error) {
          if (controller.signal.aborted) {
            job.onStatus?.('skipped', 'Skipped');
          } else {
            console.error('TTS playback failed:', error);
            job.onStatus?.('error', errorMessage(error));
          }
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.running = false;
      this.deps.setProcessing(false);
    }
  }
}

export const ttsQueueService = new TtsQueue();
