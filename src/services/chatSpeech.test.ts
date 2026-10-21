import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/services/ttsQueueService', () => ({ ttsQueueService: { enqueue: vi.fn(() => true) } }));

import { ttsQueueService } from '@/services/ttsQueueService';
import { speakChatMessage } from './chatSpeech';
import type { Message } from '@/types/message';

let nextId = 0;
const message = (content: string, username = `viewer${nextId}`): Message =>
  ({ id: `m${nextId++}`, content, timestamp: 0, username });

const queued = () => vi.mocked(ttsQueueService.enqueue).mock.calls.map(([job]) => [job.text, job.language]);

describe('speakChatMessage', () => {
  beforeEach(() => vi.mocked(ttsQueueService.enqueue).mockClear());

  it('reads !г in Russian and !r in English', () => {
    speakChatMessage(message('!г Привет'), { fromViewer: true });
    speakChatMessage(message('!r Hello there'), { fromViewer: true });
    speakChatMessage(message('!R shouting'), { fromViewer: true });
    expect(queued()).toEqual([['Привет', 'ru'], ['Hello there', 'en'], ['shouting', 'en']]);
  });

  it('ignores ordinary chat and other bot commands', () => {
    for (const content of ['hello', '!rules', '!raid', '!гг']) {
      speakChatMessage(message(content), { fromViewer: true });
    }
    expect(queued()).toEqual([]);
  });
});
