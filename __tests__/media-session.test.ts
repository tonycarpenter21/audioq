import {
  createAudioQueue,
  destroyAllChannels,
  getCurrentAudioInfo,
  getQueueLength,
  isChannelPaused,
  pauseChannel,
  queueAudio,
  setQueueConfig
} from '../src/queue';
import type { AudioQueue } from '../src/queue';
import { getDefaultAudioQueue } from '../src/default-queue';
import { connectMediaSession } from '../src/media-session';
import { FakeAudio, audioAt, flush, installFakeAudio } from './helpers/fake-audio';

class FakeMediaMetadata {
  constructor(readonly init: MediaMetadataInit) {}
}

interface FakeSession {
  handlers: Map<string, ((details: Record<string, unknown>) => void) | null>;
  metadata: FakeMediaMetadata | null;
  playbackState: string;
  positions: Record<string, number>[];
  setActionHandler: jest.Mock;
  setPositionState: jest.Mock;
}

const installSession = (unsupported: string[] = []): FakeSession => {
  const session: FakeSession = {
    handlers: new Map(),
    metadata: null,
    playbackState: 'none',
    positions: [],
    setActionHandler: jest.fn(
      (action: string, handler: ((details: Record<string, unknown>) => void) | null) => {
        if (unsupported.includes(action)) throw new TypeError(`${action} is not supported`);
        session.handlers.set(action, handler);
      }
    ),
    setPositionState: jest.fn((state: Record<string, number>) => session.positions.push(state))
  };
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session });
  (globalThis as { MediaMetadata?: unknown }).MediaMetadata = FakeMediaMetadata;
  return session;
};

const action = (session: FakeSession, name: string, details: Record<string, unknown> = {}): void =>
  session.handlers.get(name)?.({ action: name, ...details });

let queue: AudioQueue;

beforeEach(() => {
  jest.useFakeTimers();
  installFakeAudio();
  queue = createAudioQueue({ logger: null });
});

afterEach(() => {
  jest.useRealTimers();
  delete (navigator as { mediaSession?: unknown }).mediaSession;
  delete (globalThis as { MediaMetadata?: unknown }).MediaMetadata;
});

describe('connectMediaSession', () => {
  test('shows metadata and playing state when an item starts', async () => {
    const session = installSession();
    connectMediaSession({ queue });
    await queueAudio(queue, '/ep42.mp3', 0, {
      metadata: { album: 'Season 2', artist: 'My Podcast', title: 'Episode 42' }
    });
    await flush();
    expect(session.metadata?.init).toEqual({
      album: 'Season 2',
      artist: 'My Podcast',
      artwork: [],
      title: 'Episode 42'
    });
    expect(session.playbackState).toBe('playing');
  });

  test('falls back to the file name as the title', async () => {
    const session = installSession();
    connectMediaSession({ queue });
    await queueAudio(queue, '/sfx/chime.mp3');
    await flush();
    expect(session.metadata?.init.title).toBe('chime.mp3');
  });

  test('buttons control the channel', async () => {
    const session = installSession();
    connectMediaSession({ channel: 2, queue, seekOffsetMs: 5000 });
    await queueAudio(queue, '/a.mp3', 2);
    await queueAudio(queue, '/b.mp3', 2);
    await flush();
    action(session, 'pause');
    expect(isChannelPaused(queue, 2)).toBe(true);
    expect(session.playbackState).toBe('paused');
    action(session, 'play');
    await flush();
    expect(isChannelPaused(queue, 2)).toBe(false);
    action(session, 'seekto', { seekTime: 6 });
    expect(audioAt(0).currentTime).toBe(6);
    action(session, 'seekbackward');
    expect(audioAt(0).currentTime).toBe(1);
    action(session, 'seekforward', { seekOffset: 2 });
    expect(audioAt(0).currentTime).toBe(3);
    action(session, 'seekto', {});
    expect(audioAt(0).currentTime).toBe(3);
    action(session, 'previoustrack');
    expect(audioAt(0).currentTime).toBe(0);
    action(session, 'nexttrack');
    expect(getCurrentAudioInfo(queue, 2)?.fileName).toBe('b.mp3');
    action(session, 'stop');
    expect(getQueueLength(queue, 2)).toBe(0);
  });

  test('reports position, and clears the session when the queue runs out', async () => {
    const session = installSession();
    connectMediaSession({ queue });
    await queueAudio(queue, '/a.mp3');
    await flush();
    audioAt(0).tick(4);
    expect(session.positions[session.positions.length - 1]).toEqual({
      duration: 10,
      playbackRate: 1,
      position: 4
    });
    audioAt(0).finish();
    await flush();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe('none');
  });

  test('keeps the session while more items are queued', async () => {
    const session = installSession();
    connectMediaSession({ queue });
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await flush();
    audioAt(0).finish();
    await flush();
    expect(session.metadata?.init.title).toBe('b.mp3');
  });

  test('ignores position errors', async () => {
    const session = installSession();
    session.setPositionState.mockImplementation(() => {
      throw new Error('InvalidStateError');
    });
    connectMediaSession({ queue });
    await queueAudio(queue, '/a.mp3');
    await flush();
    expect(() => audioAt(0).tick(1)).not.toThrow();
  });

  test('does not report a position while the duration is unknown (live streams)', async () => {
    FakeAudio.defaultPlayBehavior = 'resolve-silently';
    const session = installSession();
    connectMediaSession({ queue });
    await queueAudio(queue, '/live.mp3');
    audioAt(0).tick(5);
    expect(session.positions).toEqual([]);
  });

  test('shows an item that was already playing when connecting', async () => {
    await queueAudio(queue, '/a.mp3');
    await flush();
    await pauseChannel(queue);
    const session = installSession();
    connectMediaSession({ queue });
    expect(session.metadata?.init.title).toBe('a.mp3');
    expect(session.playbackState).toBe('paused');
  });

  test('disconnect removes handlers and listeners and clears the session', async () => {
    const session = installSession();
    const disconnect = connectMediaSession({ queue });
    disconnect();
    expect([...session.handlers.values()].every((handler) => handler === null)).toBe(true);
    await queueAudio(queue, '/a.mp3');
    await flush();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe('none');
  });

  test('skips actions the browser does not support', async () => {
    const session = installSession(['seekto', 'stop']);
    expect(() => connectMediaSession({ queue })()).not.toThrow();
    expect(session.handlers.has('play')).toBe(true);
    expect(session.handlers.has('seekto')).toBe(false);
  });

  test('works without MediaMetadata (sets state only)', async () => {
    const session = installSession();
    delete (globalThis as { MediaMetadata?: unknown }).MediaMetadata;
    connectMediaSession({ queue });
    await queueAudio(queue, '/a.mp3');
    await flush();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe('playing');
  });

  test('uses the default queue when none is given', async () => {
    setQueueConfig(getDefaultAudioQueue(), { logger: null });
    const session = installSession();
    const disconnect = connectMediaSession();
    await queueAudio(getDefaultAudioQueue(), '/default.mp3');
    await flush();
    expect(session.metadata?.init.title).toBe('default.mp3');
    disconnect();
    await destroyAllChannels(getDefaultAudioQueue());
  });

  test('is a no-op without the Media Session API', () => {
    const disconnect = connectMediaSession({ queue });
    expect(typeof disconnect).toBe('function');
    expect(() => disconnect()).not.toThrow();
  });
});
