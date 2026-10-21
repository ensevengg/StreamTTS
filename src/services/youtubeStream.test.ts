import { describe, it, expect, beforeEach, vi } from 'vitest';
import { commandHandlers, desktopTauriApi, fakeInvoke, resetDesktop } from '@/test/desktopMock';

vi.mock('@/lib/tauri-api', async () => {
  /** Stands in for Tauri's IPC Channel; the fake backend calls onmessage. */
  class FakeChannel<T> {
    onmessage: (message: T) => void = () => {};
  }
  return { ...(await desktopTauriApi()), Channel: FakeChannel };
});

import {
  streamLiveChat,
  StreamTransportError,
  StreamUnavailableError,
  YouTubeApiError,
  type LiveChatPage,
} from './youtubeService';

type Emit = (event: object) => void;

/** Registers a fake youtube_chat_stream command and hands back its channel. */
function backend(): Promise<{ emit: Emit; args: Record<string, unknown> }> {
  return new Promise(resolve => {
    commandHandlers.set('youtube_chat_stream', (args) => {
      const channel = args.onEvent as { onmessage: (e: object) => void };
      resolve({ emit: (event) => channel.onmessage(event), args });
      return null;
    });
  });
}

describe('streamLiveChat', () => {
  beforeEach(() => resetDesktop());

  it('forwards pages and resolves when YouTube closes the stream', async () => {
    const opened = backend();
    const pages: LiveChatPage[] = [];
    const done = streamLiveChat('token', 'chat1', 'p0', (p) => pages.push(p), new AbortController().signal);
    const { emit, args } = await opened;

    expect(args).toMatchObject({ accessToken: 'token', liveChatId: 'chat1', pageToken: 'p0' });
    emit({ event: 'page', page: { items: [], nextPageToken: 'p1' } });
    emit({ event: 'end', error: null });
    await expect(done).resolves.toBeUndefined();
    expect(pages).toEqual([{ items: [], nextPageToken: 'p1' }]);
  });

  it('turns stream failures into the errors the chat session understands', async () => {
    const cases: [object, unknown][] = [
      [{ status: 403, reason: 'liveChatEnded', message: 'LIVE_CHAT_ENDED' }, YouTubeApiError],
      [{ status: 0, reason: 'unavailable', message: 'connect error' }, StreamTransportError],
      [{ status: 501, reason: 'streamUnsupported', message: 'unimplemented' }, StreamUnavailableError],
    ];
    for (const [failure, type] of cases) {
      const opened = backend();
      const done = streamLiveChat('token', 'chat1', null, () => {}, new AbortController().signal);
      (await opened).emit({ event: 'end', error: failure });
      await expect(done).rejects.toBeInstanceOf(type);
    }
  });

  it('stops the backend stream when aborted', async () => {
    commandHandlers.set('youtube_chat_stream_stop', () => null);
    const opened = backend();
    const controller = new AbortController();
    const done = streamLiveChat('token', 'chat1', null, () => {}, controller.signal);
    const { args } = await opened;

    controller.abort();
    await expect(done).resolves.toBeUndefined();
    expect(fakeInvoke).toHaveBeenCalledWith('youtube_chat_stream_stop', { streamId: args.streamId });
  });

  it('reports streaming as unavailable if the command itself fails', async () => {
    commandHandlers.set('youtube_chat_stream', () => {
      throw new Error('command not found');
    });
    await expect(streamLiveChat('token', 'chat1', null, () => {}, new AbortController().signal))
      .rejects.toBeInstanceOf(StreamUnavailableError);
  });
});
