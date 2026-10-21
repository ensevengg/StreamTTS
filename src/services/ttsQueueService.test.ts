import { describe, it, expect, vi } from 'vitest';
import { MAX_QUEUE_LENGTH, MAX_QUEUED_PER_VIEWER, TtsQueue, type SpeechJob } from './ttsQueueService';
import type { SpeakOptions } from './ttsService';

/** Speech that finishes only when the test says so (or is aborted). */
function controllableSpeech() {
  const spoken: string[] = [];
  const pending: { text: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  const speak = vi.fn((text: string, { signal }: SpeakOptions) => new Promise<void>((resolve, reject) => {
    spoken.push(text);
    pending.push({ text, resolve, reject });
    signal.addEventListener('abort', () => reject(new DOMException('skipped', 'AbortError')), { once: true });
  }));
  const finishCurrent = async () => {
    pending.shift()?.resolve();
    await flush();
  };
  return { speak, spoken, pending, finishCurrent };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function makeQueue(speak: (text: string, options: SpeakOptions) => Promise<void>) {
  const processing: boolean[] = [];
  const queue = new TtsQueue({
    speak,
    getSettings: () => ({ provider: 'browser', apiKey: '', volume: 0.7, voiceName: undefined }),
    setProcessing: (p) => processing.push(p),
  });
  return { queue, processing };
}

const job = (id: string, extra: Partial<SpeechJob> = {}): SpeechJob & { statuses: string[] } => {
  const statuses: string[] = [];
  return { id, text: id, onStatus: (s) => statuses.push(s), statuses, ...extra };
};

describe('TtsQueue', () => {
  it('speaks jobs one at a time, in order', async () => {
    const speech = controllableSpeech();
    const { queue, processing } = makeQueue(speech.speak);
    const a = job('a');
    const b = job('b');
    queue.enqueue(a);
    queue.enqueue(b);
    await flush();
    expect(speech.spoken).toEqual(['a']);

    await speech.finishCurrent();
    expect(speech.spoken).toEqual(['a', 'b']);
    await speech.finishCurrent();

    expect(a.statuses).toEqual(['playing', 'completed']);
    expect(b.statuses).toEqual(['playing', 'completed']);
    expect(processing).toEqual([true, false]);
  });

  it('skip stops the current job and moves on', async () => {
    const speech = controllableSpeech();
    const { queue } = makeQueue(speech.speak);
    const a = job('a');
    queue.enqueue(a);
    queue.enqueue(job('b'));
    await flush();

    queue.skip();
    await flush();
    expect(a.statuses).toEqual(['playing', 'skipped']);
    expect(speech.spoken).toEqual(['a', 'b']);
  });

  it('clear drops waiting jobs and stops playback', async () => {
    const speech = controllableSpeech();
    const { queue } = makeQueue(speech.speak);
    const a = job('a');
    const b = job('b');
    queue.enqueue(a);
    queue.enqueue(b);
    await flush();

    queue.clear();
    await flush();
    expect(a.statuses).toEqual(['playing', 'skipped']);
    expect(b.statuses).toEqual(['skipped']);
    expect(queue.length).toBe(0);
  });

  it('when full, drops the oldest waiting job, never the one being spoken', async () => {
    const speech = controllableSpeech();
    const { queue } = makeQueue(speech.speak);
    const playing = job('playing');
    queue.enqueue(playing);
    await flush();

    const waiting = Array.from({ length: MAX_QUEUE_LENGTH }, (_, i) => job(`w${i}`));
    waiting.forEach(j => queue.enqueue(j));
    const overflow = job('overflow');
    queue.enqueue(overflow);

    expect(playing.statuses).toEqual(['playing']);
    expect(waiting[0].statuses).toEqual(['skipped']);

    await speech.finishCurrent();
    // The next one spoken is the oldest job that is still waiting.
    expect(speech.spoken[1]).toBe('w1');
    expect(playing.statuses).toEqual(['playing', 'completed']);
  });

  it('caps how many jobs one viewer can have waiting', async () => {
    const speech = controllableSpeech();
    const { queue } = makeQueue(speech.speak);
    queue.enqueue(job('first', { owner: 'spammer' }));
    await flush();
    for (let i = 0; i < MAX_QUEUED_PER_VIEWER; i++) {
      expect(queue.enqueue(job(`s${i}`, { owner: 'spammer' }))).toBe(true);
    }
    expect(queue.enqueue(job('extra', { owner: 'spammer' }))).toBe(false);
    expect(queue.enqueue(job('other', { owner: 'someone-else' }))).toBe(true);
  });

  it('puts alerts ahead of waiting chat, behind earlier alerts', async () => {
    const speech = controllableSpeech();
    const { queue } = makeQueue(speech.speak);
    queue.enqueue(job('chat1'));
    queue.enqueue(job('chat2'));
    queue.enqueue(job('alert1', { priority: true }));
    queue.enqueue(job('alert2', { priority: true }));
    await flush();
    for (let i = 0; i < 4; i++) await speech.finishCurrent();
    expect(speech.spoken).toEqual(['chat1', 'alert1', 'alert2', 'chat2']);
  });

  it('marks failures and keeps going', async () => {
    const speak = vi.fn()
      .mockRejectedValueOnce(new Error('ElevenLabs request failed (401)'))
      .mockResolvedValue(undefined);
    const { queue } = makeQueue(speak);
    const failed = job('failed');
    const next = job('next');
    queue.enqueue(failed);
    queue.enqueue(next);
    await flush();
    await flush();
    expect(failed.statuses).toEqual(['playing', 'error']);
    expect(next.statuses).toEqual(['playing', 'completed']);
  });

  it('uses a job volume override', async () => {
    const speak = vi.fn().mockResolvedValue(undefined);
    const { queue } = makeQueue(speak);
    queue.enqueue(job('alert', { volume: 0.2 }));
    await flush();
    expect(speak.mock.calls[0][1].volume).toBe(0.2);
  });
});
