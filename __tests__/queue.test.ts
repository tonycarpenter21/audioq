import type { AudioQueue } from '../src/queue';
import {
  getWebAudioSupport,
  cancelAllVolumeTransitions,
  cancelVolumeTransition,
  clearQueueAfterCurrent,
  clearVolumeDucking,
  createAudioQueue,
  destroyAllChannels,
  destroyChannel,
  getAllChannelsInfo,
  getAllChannelsPauseState,
  getAllChannelsVolume,
  getChannelAnalyser,
  getChannelPan,
  getChannelVolume,
  getCurrentAudioInfo,
  getGlobalVolume,
  getQueueConfig,
  getQueueItemInfo,
  getQueueLength,
  getQueueSnapshot,
  isChannelPaused,
  offAudioComplete,
  offAudioError,
  offAudioPause,
  offAudioProgress,
  offAudioResume,
  offAudioStart,
  offQueueChange,
  onAudioComplete,
  onAudioError,
  onAudioPause,
  onAudioProgress,
  onAudioResume,
  onAudioStart,
  onQueueChange,
  pauseAllChannels,
  pauseAllWithFade,
  pauseChannel,
  pauseWithFade,
  queueAudio,
  queueAudioPriority,
  removeQueuedItem,
  reorderQueue,
  resumeAllChannels,
  resumeAllWithFade,
  resumeChannel,
  resumeWithFade,
  setAllChannelsVolume,
  setChannelPan,
  setChannelQueueLimit,
  setChannelVolume,
  setGlobalVolume,
  setMuted,
  setQueueConfig,
  setVolumeDucking,
  stopAllAudio,
  stopAllAudioInChannel,
  stopCurrentAudioInChannel,
  swapQueueItems,
  togglePauseAllChannels,
  togglePauseAllWithFade,
  togglePauseChannel,
  togglePauseWithFade,
  transitionVolume,
  unlockAudio,
  seekBy
} from '../src/queue';
import type { AudioInfo, AudioQueueOptions, QueueConfig, QueueSnapshot } from '../src/types';
import { AudioErrorType, EasingType, FadeType } from '../src/types';
import {
  DESKTOP_UA,
  FakeAudio,
  FakeAudioContext,
  IPHONE_UA,
  advance,
  audioAt,
  callArg,
  flush,
  installFakeAudio,
  installFakeAudioContext,
  removeAudioContext,
  setUserAgent
} from './helpers/fake-audio';

const setup = (config: Partial<QueueConfig> = {}): AudioQueue =>
  createAudioQueue({ logger: null, ...config });

const names = (snapshot: QueueSnapshot | null): string[] =>
  snapshot?.items.map((item) => item.fileName) ?? [];

beforeEach(() => {
  jest.useFakeTimers();
  installFakeAudio();
  removeAudioContext();
  setUserAgent(DESKTOP_UA);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createAudioQueue / constructor', () => {
  test('creates independent instances', async () => {
    const a = setup();
    const b = setup();
    expect(a).not.toBe(b);
    await queueAudio(a, '/a.mp3');
    expect(getQueueLength(a)).toBe(1);
    expect(getQueueLength(b)).toBe(0);
  });

  test('validates configuration', () => {
    expect(() => createAudioQueue({ maxChannels: 0 })).toThrow(RangeError);
  });
});

describe('configuration', () => {
  test('setQueueConfig merges, getQueueConfig returns a copy', () => {
    const queue = setup();
    setQueueConfig(queue, { defaultMaxQueueSize: 4 });
    const config = getQueueConfig(queue);
    expect(config.defaultMaxQueueSize).toBe(4);
    config.defaultMaxQueueSize = 99;
    expect(getQueueConfig(queue).defaultMaxQueueSize).toBe(4);
  });

  test('setChannelQueueLimit validates input', () => {
    const queue = setup();
    expect(() => setChannelQueueLimit(queue, 0, 0)).toThrow(RangeError);
    expect(() => setChannelQueueLimit(queue, -1, 2)).toThrow(RangeError);
    expect(() => setChannelQueueLimit(queue, 0, undefined)).not.toThrow();
  });

  test('getWebAudioSupport reflects the configured mode', () => {
    installFakeAudioContext();
    expect(getWebAudioSupport(setup({ webAudio: 'force' })).usingWebAudio).toBe(true);
    expect(getWebAudioSupport(setup({ webAudio: 'off' })).usingWebAudio).toBe(false);
  });
});

describe('queueAudio', () => {
  test('starts an idle channel immediately and returns a handle', async () => {
    const queue = setup();
    const item = await queueAudio(queue, '/sfx/a.mp3');
    expect(item.channelNumber).toBe(0);
    expect(item.src).toBe('http://localhost/sfx/a.mp3');
    expect(audioAt(0).playCalls).toBe(1);
    await expect(item.started).resolves.toBe(true);
  });

  test('waits for the current item before playing the next', async () => {
    const queue = setup();
    const first = await queueAudio(queue, '/a.mp3');
    const second = await queueAudio(queue, '/b.mp3');
    await flush();
    expect(audioAt(1).playCalls).toBe(0);
    audioAt(0).finish();
    await flush();
    await expect(first.finished).resolves.toBe('ended');
    expect(audioAt(1).playCalls).toBe(1);
    await expect(second.started).resolves.toBe(true);
  });

  test('ids are unique and match snapshot ids', async () => {
    const queue = setup();
    const a = await queueAudio(queue, '/a.mp3');
    const b = await queueAudio(queue, '/b.mp3');
    expect(a.id).not.toBe(b.id);
    expect(getQueueSnapshot(queue)?.items.map((i) => i.id)).toEqual([a.id, b.id]);
  });

  test.each(['', '   ', 42, null])('rejects invalid URL %p', async (url) => {
    await expect(queueAudio(setup(), url as string)).rejects.toThrow(TypeError);
  });

  test.each([
    'blob:http://localhost/9b1c',
    'data:audio/wav;base64,UklGRiQAAABXQVZF',
    '../sounds/beep.mp3',
    'capacitor://localhost/beep.mp3',
    '/api/tts?text=hi'
  ])('accepts legitimate source %s', async (url) => {
    await expect(queueAudio(setup(), url)).resolves.toBeDefined();
  });

  test.each([-1, 64, 1.5, NaN])('rejects channel %p with RangeError', async (channel) => {
    await expect(queueAudio(setup(), '/a.mp3', channel)).rejects.toThrow(RangeError);
  });

  test('respects a custom maxChannels', async () => {
    const queue = setup({ maxChannels: 2 });
    await expect(queueAudio(queue, '/a.mp3', 1)).resolves.toBeDefined();
    await expect(queueAudio(queue, '/a.mp3', 2)).rejects.toThrow(RangeError);
  });

  test('explains when HTMLAudioElement is missing', async () => {
    const saved = (globalThis as { Audio?: unknown }).Audio;
    delete (globalThis as { Audio?: unknown }).Audio;
    try {
      await expect(queueAudio(setup(), '/a.mp3')).rejects.toThrow(/browser environment/);
    } finally {
      (globalThis as { Audio?: unknown }).Audio = saved;
    }
  });

  test('addToFront inserts right after the current item', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await queueAudio(queue, '/c.mp3', 0, { addToFront: true });
    expect(names(getQueueSnapshot(queue))).toEqual(['a.mp3', 'c.mp3', 'b.mp3']);
  });

  test('addToFront on an empty channel just plays', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3', 0, { addToFront: true });
    expect(audioAt(0).playCalls).toBe(1);
  });

  test('queueAudioPriority is addToFront', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await queueAudioPriority(queue, '/urgent.mp3', 0, { volume: 0.5 });
    expect(names(getQueueSnapshot(queue))).toEqual(['a.mp3', 'urgent.mp3', 'b.mp3']);
    expect(getQueueItemInfo(queue, 1)?.volume).toBe(0.5);
  });

  test('applies loop, crossOrigin and item volume to the element', async () => {
    const queue = setup();
    await setChannelVolume(queue, 0, 0.5);
    await queueAudio(queue, 'https://cdn.example.com/a.mp3', 0, {
      crossOrigin: 'anonymous',
      loop: true,
      volume: 0.4
    });
    const audio = audioAt(0);
    expect(audio.loop).toBe(true);
    expect(audio.crossOrigin).toBe('anonymous');
    expect(audio.volume).toBeCloseTo(0.2);
    expect(getChannelVolume(queue, 0)).toBe(0.5);
  });

  test('clamps item volume', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3', 0, { volume: 7 });
    expect(getQueueItemInfo(queue, 0)?.volume).toBe(1);
  });
});

describe('prefetching', () => {
  test('only the current and next item get elements', async () => {
    const queue = setup();
    for (const n of ['a', 'b', 'c', 'd']) await queueAudio(queue, `/${n}.mp3`);
    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances.every((audio) => audio.preload === 'auto')).toBe(true);
    audioAt(0).finish();
    await flush();
    expect(FakeAudio.instances).toHaveLength(3);
  });

  test('prefetchCount 0 creates only the current element', async () => {
    const queue = setup({ prefetchCount: 0 });
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    expect(FakeAudio.instances).toHaveLength(1);
  });

  test('on iOS no upcoming item is preloaded: each element is created when its turn comes', async () => {
    setUserAgent(IPHONE_UA);
    const queue = setup({ prefetchCount: 2 });
    for (const n of ['a', 'b', 'c']) await queueAudio(queue, `/${n}.mp3`);
    expect(FakeAudio.instances).toHaveLength(1);
    audioAt(0).finish();
    await flush();
    expect(FakeAudio.instances).toHaveLength(2);
    expect(audioAt(1).src).toMatch(/b\.mp3$/);
    expect(audioAt(1).paused).toBe(false);
  });

  test('reordering pulls the new next item into the prefetch window', async () => {
    const queue = setup();
    for (const n of ['a', 'b', 'c']) await queueAudio(queue, `/${n}.mp3`);
    await reorderQueue(queue, 2, 1);
    expect(FakeAudio.instances.map((a) => a.src.split('/').pop())).toContain('c.mp3');
  });
});

describe('queue limits', () => {
  test('rejects when the channel is full', async () => {
    const queue = setup({ defaultMaxQueueSize: 2 });
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await expect(queueAudio(queue, '/c.mp3')).rejects.toThrow(/limit exceeded/);
  });

  test('per-call maxQueueSize applies to that call only', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    await expect(queueAudio(queue, '/b.mp3', 0, { maxQueueSize: 1 })).rejects.toThrow();
    await expect(queueAudio(queue, '/b.mp3')).resolves.toBeDefined();
  });

  test('setChannelQueueLimit limits one channel', async () => {
    const queue = setup();
    setChannelQueueLimit(queue, 1, 1);
    await queueAudio(queue, '/a.mp3', 1);
    await expect(queueAudio(queue, '/b.mp3', 1)).rejects.toThrow();
    await expect(queueAudio(queue, '/b.mp3', 2)).resolves.toBeDefined();
  });

  test('dropOldestWhenFull drops the oldest waiting item, never the current one', async () => {
    const queue = setup({ defaultMaxQueueSize: 2, dropOldestWhenFull: true });
    await queueAudio(queue, '/a.mp3');
    const b = await queueAudio(queue, '/b.mp3');
    await queueAudio(queue, '/c.mp3');
    expect(names(getQueueSnapshot(queue))).toEqual(['a.mp3', 'c.mp3']);
    await expect(b.finished).resolves.toBe('removed');
  });

  test('dropOldestWhenFull still rejects when only the current item exists', async () => {
    const queue = setup({ defaultMaxQueueSize: 1, dropOldestWhenFull: true });
    await queueAudio(queue, '/a.mp3');
    await expect(queueAudio(queue, '/b.mp3')).rejects.toThrow();
  });

  test('warns through the logger unless warnings are off', async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const queue = createAudioQueue({ defaultMaxQueueSize: 1, logger });
    await queueAudio(queue, '/a.mp3');
    await expect(queueAudio(queue, '/b.mp3')).rejects.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('limit 1'));
    setQueueConfig(queue, { showQueueWarnings: false });
    await expect(queueAudio(queue, '/b.mp3')).rejects.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('events', () => {
  test('start, complete and queue change fire in order with useful payloads', async () => {
    const queue = setup();
    const log: string[] = [];
    onQueueChange(queue, 0, (s) => log.push(`queue:${s.totalItems}`));
    onAudioStart(queue, 0, (i) => log.push(`start:${i.fileName}:${i.duration}`));
    onAudioComplete(queue, 0, (i) =>
      log.push(`complete:${i.fileName}:${i.reason}:${i.remainingInQueue}`)
    );
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await flush();
    audioAt(0).finish();
    await flush();
    expect(log).toEqual([
      'queue:1',
      'start:a.mp3:10000',
      'queue:2',
      'complete:a.mp3:ended:1',
      'queue:1',
      'start:b.mp3:10000'
    ]);
  });

  test('start fires once per item even if playback resumes', async () => {
    const queue = setup();
    const start = jest.fn();
    onAudioStart(queue, 0, start);
    await queueAudio(queue, '/a.mp3');
    await flush();
    await pauseChannel(queue);
    await resumeChannel(queue);
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
  });

  test('on* returns an unsubscribe that removes only that listener', async () => {
    const queue = setup();
    const a = jest.fn();
    const b = jest.fn();
    const offA = onQueueChange(queue, 0, a);
    onQueueChange(queue, 0, b);
    offA();
    await queueAudio(queue, '/a.mp3');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  test('off* with a callback removes just that callback; without removes all', async () => {
    const queue = setup();
    const a = jest.fn();
    const b = jest.fn();
    onAudioStart(queue, 0, a);
    onAudioStart(queue, 0, b);
    offAudioStart(queue, 0, a);
    await queueAudio(queue, '/a.mp3');
    await flush();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    offAudioStart(queue, 0);
    audioAt(0).finish();
    await queueAudio(queue, '/b.mp3');
    await flush();
    expect(b).toHaveBeenCalledTimes(1);
  });

  test('pause and resume listeners receive (channel, info) and can be removed by callback', async () => {
    const queue = setup();
    const onPause = jest.fn();
    const onResume = jest.fn();
    onAudioPause(queue, 2, onPause);
    onAudioResume(queue, 2, onResume);
    await queueAudio(queue, '/a.mp3', 2);
    await flush();
    await pauseChannel(queue, 2);
    await resumeChannel(queue, 2);
    expect(onPause).toHaveBeenCalledWith(2, expect.objectContaining({ fileName: 'a.mp3' }));
    expect(onResume).toHaveBeenCalledWith(2, expect.objectContaining({ isPaused: false }));
    offAudioPause(queue, 2, onPause);
    offAudioResume(queue, 2, onResume);
    await pauseChannel(queue, 2);
    await resumeChannel(queue, 2);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test('off* without a callback clears pause, resume, complete, progress, queue and error', () => {
    const queue = setup();
    const spies = Array.from({ length: 7 }, () => jest.fn());
    onAudioPause(queue, 0, spies[0] as jest.Mock);
    onAudioResume(queue, 0, spies[1] as jest.Mock);
    onAudioComplete(queue, 0, spies[2] as jest.Mock);
    onAudioProgress(queue, 0, spies[3] as jest.Mock);
    onQueueChange(queue, 0, spies[4] as jest.Mock);
    onAudioError(queue, 0, spies[5] as jest.Mock);
    offAudioPause(queue);
    offAudioResume(queue);
    offAudioComplete(queue);
    offAudioProgress(queue);
    offQueueChange(queue);
    offAudioError(queue);
    void queueAudio(queue, '/a.mp3');
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  test('subscribing validates the channel number', () => {
    const queue = setup();
    expect(() => onAudioStart(queue, -1, jest.fn())).toThrow(RangeError);
    expect(() => onAudioPause(queue, 99, jest.fn())).toThrow(RangeError);
    expect(() => onAudioResume(queue, 1.5, jest.fn())).toThrow(RangeError);
  });

  test('a throwing listener is logged and does not break playback', async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const queue = createAudioQueue({ logger });
    onQueueChange(queue, 0, () => {
      throw new Error('listener bug');
    });
    await queueAudio(queue, '/a.mp3');
    expect(logger.error).toHaveBeenCalledWith('audioq: error in event listener', expect.any(Error));
    expect(audioAt(0).playCalls).toBe(1);
  });

  test('progress reports position for the current item only', async () => {
    const queue = setup();
    const progress: AudioInfo[] = [];
    onAudioProgress(queue, 0, (info) => progress.push(info));
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await flush();
    audioAt(0).tick(5);
    audioAt(1).tick(3);
    const last = progress[progress.length - 1];
    expect(last).toMatchObject({ currentTime: 5000, duration: 10000, fileName: 'a.mp3' });
    expect(last?.progress).toBeCloseTo(0.5);
    expect(progress.every((p) => p.fileName === 'a.mp3')).toBe(true);
  });
});

describe('errors', () => {
  test('a failing current item reports once, is skipped, and is never retried', async () => {
    FakeAudio.defaultPlayBehavior = 'resolve-silently';
    const queue = setup();
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    const a = await queueAudio(queue, '/missing.mp3');
    await queueAudio(queue, '/b.mp3');
    audioAt(0).fail(4);
    await flush();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(callArg(errors)).toMatchObject({
      errorType: AudioErrorType.Unsupported,
      fileName: 'missing.mp3',
      remainingInQueue: 1
    });
    await expect(a.finished).resolves.toBe('error');
    await expect(a.started).resolves.toBe(false);
    expect(audioAt(1).playCalls).toBe(1);
    await advance(60000, 1000);
    expect(audioAt(0).playCalls).toBe(1);
  });

  test('a failing waiting item is removed without touching the current one', async () => {
    const queue = setup();
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    await queueAudio(queue, '/one.mp3');
    const two = await queueAudio(queue, '/two.mp3');
    await queueAudio(queue, '/three.mp3');
    await flush();
    audioAt(1).fail(2, 'net::ERR_FAILED');
    await flush();
    expect(audioAt(1).playCalls).toBe(0);
    expect(audioAt(0).paused).toBe(false);
    expect(names(getQueueSnapshot(queue))).toEqual(['one.mp3', 'three.mp3']);
    expect(callArg(errors)).toMatchObject({
      errorType: AudioErrorType.Network,
      remainingInQueue: 1
    });
    await expect(two.finished).resolves.toBe('error');
  });

  test('media error without a message gets a descriptive one', async () => {
    const queue = setup();
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    await queueAudio(queue, '/a.mp3');
    audioAt(0).fail(3, '');
    await flush();
    expect(callArg(errors)).toMatchObject({ error: { message: 'Media error (decode)' } });
  });

  test('error events after an item was released are ignored', async () => {
    const queue = setup();
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    await queueAudio(queue, '/a.mp3');
    const audio = audioAt(0);
    await stopAllAudioInChannel(queue);
    audio.fail();
    expect(errors).not.toHaveBeenCalled();
  });

  test.each([
    ['not-supported', AudioErrorType.Unsupported],
    ['generic-error', AudioErrorType.Unknown],
    ['throw-sync', AudioErrorType.Unknown]
  ] as const)('play() rejection %s is reported as %s and skipped', async (behavior, type) => {
    FakeAudio.defaultPlayBehavior = behavior;
    const queue = setup();
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await flush();
    expect(callArg(errors)).toMatchObject({ errorType: type });
    expect(names(getQueueSnapshot(queue))).not.toContain('a.mp3');
  });

  test('AbortError from play() is not an error', async () => {
    FakeAudio.defaultPlayBehavior = 'abort';
    const queue = setup();
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    await queueAudio(queue, '/a.mp3');
    await flush();
    expect(errors).not.toHaveBeenCalled();
    expect(getQueueLength(queue)).toBe(1);
  });

  test('a stale play() rejection after the item was stopped is ignored', async () => {
    FakeAudio.defaultPlayBehavior = 'hang';
    const queue = setup();
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    await queueAudio(queue, '/a.mp3');
    await stopCurrentAudioInChannel(queue);
    await flush();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('autoplay blocking', () => {
  describe('reusing elements that have played (iOS refuses new ones outside a tap)', () => {
    const playThenRefuseNew = async (queue: AudioQueue, ...files: string[]): Promise<void> => {
      for (const file of files) await queueAudio(queue, file);
      await flush();
      audioAt(0).playBehavior = 'resolve'; // it played, so the browser keeps allowing it
      FakeAudio.defaultPlayBehavior = 'not-allowed'; // new elements are refused from now on
      audioAt(0).finish();
      await flush();
    };

    test('a refused item moves onto an element that has played, and plays', async () => {
      const queue = setup();
      const errors = jest.fn();
      onAudioError(queue, 0, errors);
      await playThenRefuseNew(queue, '/a.mp3', '/b.mp3');
      expect(audioAt(0).src).toMatch(/\/b\.mp3$/);
      expect(audioAt(0).playCalls).toBe(2);
      expect(getCurrentAudioInfo(queue)?.fileName).toBe('b.mp3');
      expect(getCurrentAudioInfo(queue)?.isPlaying).toBe(true);
      expect(errors).not.toHaveBeenCalled();
    });

    test('the reused element starts clean: unmuted, full volume, the new item looping or not', async () => {
      const queue = setup();
      await queueAudio(queue, '/a.mp3');
      await queueAudio(queue, '/b.mp3', 0, { loop: true });
      await flush();
      audioAt(0).muted = true;
      audioAt(0).playBehavior = 'resolve';
      FakeAudio.defaultPlayBehavior = 'not-allowed';
      audioAt(0).finish();
      await flush();
      expect(audioAt(0).src).toMatch(/\/b\.mp3$/);
      expect(audioAt(0).muted).toBe(false);
      expect(audioAt(0).loop).toBe(true);
    });

    test('if the reused element is refused too, the item waits for a tap (one error)', async () => {
      const queue = setup();
      const errors = jest.fn();
      onAudioError(queue, 0, errors);
      await playThenRefuseNew(queue, '/a.mp3', '/b.mp3');
      // a reused element can be refused as well (for example after the page was backgrounded)
      await stopAllAudioInChannel(queue, 0);
      audioAt(0).playBehavior = 'not-allowed';
      await queueAudio(queue, '/c.mp3');
      await flush();
      expect(errors).toHaveBeenCalledTimes(1);
      expect(callArg(errors)).toMatchObject({
        errorType: AudioErrorType.AutoplayBlocked,
        fileName: 'c.mp3'
      });
    });

    test('elements routed through Web Audio are not reused', async () => {
      installFakeAudioContext();
      const queue = setup({ webAudio: 'force' });
      const errors = jest.fn();
      onAudioError(queue, 0, errors);
      await playThenRefuseNew(queue, '/a.mp3', '/b.mp3');
      expect(callArg(errors)).toMatchObject({
        errorType: AudioErrorType.AutoplayBlocked,
        fileName: 'b.mp3'
      });
    });

    test('destroyAllChannels forgets the spare elements', async () => {
      const queue = setup();
      const errors = jest.fn();
      await playThenRefuseNew(queue, '/a.mp3');
      await destroyAllChannels(queue);
      onAudioError(queue, 0, errors);
      await queueAudio(queue, '/b.mp3');
      await flush();
      expect(callArg(errors)).toMatchObject({ errorType: AudioErrorType.AutoplayBlocked });
    });
  });

  test('keeps the queue, reports once, and plays on the next user gesture', async () => {
    FakeAudio.defaultPlayBehavior = 'not-allowed';
    const queue = setup();
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    for (const n of ['a', 'b', 'c']) await queueAudio(queue, `/${n}.mp3`);
    await flush();
    await advance(60000, 1000);
    expect(getQueueLength(queue)).toBe(3);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(callArg(errors)).toMatchObject({ errorType: AudioErrorType.AutoplayBlocked });

    FakeAudio.defaultPlayBehavior = 'resolve';
    document.dispatchEvent(new Event('touchend'));
    await flush();
    expect(getCurrentAudioInfo(queue)?.isPlaying).toBe(true);
    const plays = audioAt(0).playCalls;
    document.dispatchEvent(new Event('keydown'));
    await flush();
    expect(audioAt(0).playCalls).toBe(plays);
  });

  test('unlockAudio retries blocked channels from your own handler', async () => {
    FakeAudio.defaultPlayBehavior = 'not-allowed';
    const queue = setup();
    await queueAudio(queue, '/a.mp3', 3);
    await flush();
    FakeAudio.defaultPlayBehavior = 'resolve';
    unlockAudio(queue);
    await flush();
    expect(getCurrentAudioInfo(queue, 3)?.isPlaying).toBe(true);
  });

  test('a paused blocked channel is not started by a gesture', async () => {
    FakeAudio.defaultPlayBehavior = 'not-allowed';
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    await flush();
    await pauseChannel(queue);
    FakeAudio.defaultPlayBehavior = 'resolve';
    const plays = audioAt(0).playCalls;
    unlockAudio(queue);
    await flush();
    expect(audioAt(0).playCalls).toBe(plays);
  });

  test('stopping a blocked channel removes the gesture listener', async () => {
    FakeAudio.defaultPlayBehavior = 'not-allowed';
    const remove = jest.spyOn(document, 'removeEventListener');
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    await flush();
    await stopAllAudio(queue);
    expect(remove).toHaveBeenCalledWith('mousedown', expect.any(Function), { capture: true });
  });
});

describe('load timeout', () => {
  test('skips an item that never starts', async () => {
    FakeAudio.defaultPlayBehavior = 'hang';
    const queue = setup({ loadTimeoutMs: 5000 });
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    const a = await queueAudio(queue, '/slow.mp3');
    await queueAudio(queue, '/b.mp3');
    await advance(4999, 1000);
    expect(errors).not.toHaveBeenCalled();
    await advance(10, 10);
    expect(callArg(errors)).toMatchObject({ errorType: AudioErrorType.Timeout });
    await expect(a.finished).resolves.toBe('error');
  });

  test('does not fire once playback started', async () => {
    const queue = setup({ loadTimeoutMs: 1000 });
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    await queueAudio(queue, '/a.mp3');
    await flush();
    await advance(5000, 500);
    expect(errors).not.toHaveBeenCalled();
  });

  test('is suspended while paused', async () => {
    FakeAudio.defaultPlayBehavior = 'hang';
    const queue = setup({ loadTimeoutMs: 1000 });
    await queueAudio(queue, '/a.mp3');
    await pauseChannel(queue);
    await advance(5000, 500);
    expect(getQueueLength(queue)).toBe(1);
  });

  test('can be disabled with 0', async () => {
    FakeAudio.defaultPlayBehavior = 'hang';
    const queue = setup({ loadTimeoutMs: 0 });
    await queueAudio(queue, '/a.mp3');
    await advance(120000, 10000);
    expect(getQueueLength(queue)).toBe(1);
  });
});

describe('stopping and destroying', () => {
  test('stopCurrentAudioInChannel completes with "stopped", releases the element, plays next', async () => {
    const queue = setup();
    const complete = jest.fn();
    onAudioComplete(queue, 0, complete);
    const a = await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await flush();
    const audio = audioAt(0);
    await stopCurrentAudioInChannel(queue);
    expect(callArg(complete)).toMatchObject({ reason: 'stopped', remainingInQueue: 1 });
    await expect(a.finished).resolves.toBe('stopped');
    expect(audio.src).toBe('');
    expect(audio.loadCalls).toBe(1);
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('stopCurrentAudioInChannel on an empty or unknown channel does nothing', async () => {
    const queue = setup();
    await expect(stopCurrentAudioInChannel(queue, 5)).resolves.toBeUndefined();
  });

  test('stopAllAudioInChannel settles every handle and releases every element', async () => {
    const queue = setup();
    const complete = jest.fn();
    const changes = jest.fn();
    onAudioComplete(queue, 0, complete);
    const handles = [];
    for (const n of ['a', 'b', 'c']) handles.push(await queueAudio(queue, `/${n}.mp3`));
    onQueueChange(queue, 0, changes);
    await stopAllAudioInChannel(queue);
    expect(getQueueLength(queue)).toBe(0);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(callArg(complete)).toMatchObject({ reason: 'stopped', remainingInQueue: 0 });
    expect(changes).toHaveBeenCalledTimes(1);
    await expect(Promise.all(handles.map((h) => h.finished))).resolves.toEqual([
      'stopped',
      'removed',
      'removed'
    ]);
    expect(FakeAudio.instances.every((audio) => audio.src === '')).toBe(true);
  });

  test('stopAllAudio clears every channel', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3', 0);
    await queueAudio(queue, '/b.mp3', 5);
    await stopAllAudio(queue);
    expect(getQueueLength(queue, 0) + getQueueLength(queue, 5)).toBe(0);
  });

  test('stopping resets pause state', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    await pauseChannel(queue);
    await stopAllAudioInChannel(queue);
    expect(isChannelPaused(queue)).toBe(false);
    await stopAllAudioInChannel(queue, 9);
  });

  test('destroyChannel removes listeners and settings; the channel can be reused', async () => {
    const queue = setup();
    const start = jest.fn();
    onAudioStart(queue, 1, start);
    await setChannelVolume(queue, 1, 0.3);
    await destroyChannel(queue, 1);
    expect(getQueueSnapshot(queue, 1)).toBeNull();
    expect(getChannelVolume(queue, 1)).toBe(1);
    await queueAudio(queue, '/a.mp3', 1);
    await flush();
    expect(start).not.toHaveBeenCalled();
  });

  test('destroyAllChannels closes the AudioContext and removes all listeners', async () => {
    installFakeAudioContext();
    const queue = setup({ webAudio: 'force' });
    const global = jest.fn();
    onAudioStart(queue, 0, global);
    await queueAudio(queue, '/a.mp3');
    await destroyAllChannels(queue);
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalled();
    await queueAudio(queue, '/b.mp3');
    await flush();
    expect(global).toHaveBeenCalledTimes(1);
  });
});

describe('queue manipulation', () => {
  const filled = async (): Promise<AudioQueue> => {
    const queue = setup();
    for (const n of ['a', 'b', 'c', 'd']) await queueAudio(queue, `/${n}.mp3`);
    return queue;
  };

  test('removeQueuedItem removes a waiting item and settles its handle', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    const b = await queueAudio(queue, '/b.mp3');
    const result = await removeQueuedItem(queue, 1);
    expect(result.success).toBe(true);
    expect(names(result.updatedQueue ?? null)).toEqual(['a.mp3']);
    await expect(b.finished).resolves.toBe('removed');
  });

  test.each([
    [0, /currently playing/],
    [9, /Invalid slot/],
    [-1, /Invalid slot/],
    [1.5, /Invalid slot/]
  ])('removeQueuedItem(%p) fails with an explanation', async (slot, message) => {
    const queue = await filled();
    const result = await removeQueuedItem(queue, slot);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(message);
  });

  test('manipulating a channel that does not exist fails cleanly', async () => {
    const queue = setup();
    expect((await removeQueuedItem(queue, 1, 3)).error).toMatch(/does not exist/);
    expect((await reorderQueue(queue, 1, 2, 3)).success).toBe(false);
    expect((await swapQueueItems(queue, 1, 2, 3)).success).toBe(false);
  });

  test('reorderQueue moves items and rejects index 0', async () => {
    const queue = await filled();
    const result = await reorderQueue(queue, 3, 1);
    expect(names(result.updatedQueue ?? null)).toEqual(['a.mp3', 'd.mp3', 'b.mp3', 'c.mp3']);
    expect((await reorderQueue(queue, 1, 0)).error).toMatch(/move to the currently playing/);
    expect((await reorderQueue(queue, 0, 1)).success).toBe(false);
    expect((await reorderQueue(queue, 1, 1)).success).toBe(true);
  });

  test('swapQueueItems swaps waiting items', async () => {
    const queue = await filled();
    const result = await swapQueueItems(queue, 1, 3);
    expect(names(result.updatedQueue ?? null)).toEqual(['a.mp3', 'd.mp3', 'c.mp3', 'b.mp3']);
    expect((await swapQueueItems(queue, 0, 2)).success).toBe(false);
    expect((await swapQueueItems(queue, 1, 7)).success).toBe(false);
    expect((await swapQueueItems(queue, 2, 2)).success).toBe(true);
  });

  test('clearQueueAfterCurrent keeps only the current item', async () => {
    const queue = await filled();
    const result = await clearQueueAfterCurrent(queue);
    expect(names(result.updatedQueue ?? null)).toEqual(['a.mp3']);
    expect((await clearQueueAfterCurrent(queue)).success).toBe(true);
    const missing = await clearQueueAfterCurrent(queue, 7);
    expect(missing.updatedQueue).toMatchObject({ currentIndex: -1, totalItems: 0 });
  });

  test('getQueueItemInfo and getQueueLength', async () => {
    const queue = await filled();
    expect(getQueueLength(queue)).toBe(4);
    expect(getQueueLength(queue, 9)).toBe(0);
    expect(getQueueItemInfo(queue, 2)?.fileName).toBe('c.mp3');
    expect(getQueueItemInfo(queue, 10)).toBeNull();
    expect(getQueueItemInfo(queue, 0, 9)).toBeNull();
  });
});

describe('pause and resume', () => {
  test('pauseChannel / resumeChannel / isChannelPaused', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    await flush();
    await pauseChannel(queue);
    expect(audioAt(0).paused).toBe(true);
    expect(isChannelPaused(queue)).toBe(true);
    await pauseChannel(queue);
    await resumeChannel(queue);
    expect(audioAt(0).paused).toBe(false);
    expect(isChannelPaused(queue)).toBe(false);
    await resumeChannel(queue);
    expect(isChannelPaused(queue, 9)).toBe(false);
  });

  test('pause before playback starts prevents it; resume starts it', async () => {
    FakeAudio.defaultPlayBehavior = 'resolve-silently';
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    await pauseChannel(queue);
    expect(audioAt(0).paused).toBe(true);
    FakeAudio.defaultPlayBehavior = 'resolve';
    await resumeChannel(queue);
    await flush();
    expect(getCurrentAudioInfo(queue)?.isPlaying).toBe(true);
  });

  test('items queued on a paused channel wait; finishing resets pause', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    await pauseChannel(queue);
    await queueAudio(queue, '/b.mp3');
    expect(audioAt(1).playCalls).toBe(0);
    await stopCurrentAudioInChannel(queue);
    expect(isChannelPaused(queue)).toBe(false);
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('togglePauseChannel flips state; empty channels are ignored', async () => {
    const queue = setup();
    await togglePauseChannel(queue);
    await queueAudio(queue, '/a.mp3');
    await togglePauseChannel(queue);
    expect(isChannelPaused(queue)).toBe(true);
    await togglePauseChannel(queue);
    expect(isChannelPaused(queue)).toBe(false);
  });

  test('pauseAll / resumeAll / togglePauseAll / getAllChannelsPauseState', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3', 0);
    await queueAudio(queue, '/b.mp3', 2);
    await pauseAllChannels(queue);
    expect(getAllChannelsPauseState(queue)).toEqual([true, false, true]);
    await resumeAllChannels(queue);
    expect(getAllChannelsPauseState(queue)).toEqual([false, false, false]);
    await togglePauseAllChannels(queue);
    expect(isChannelPaused(queue, 2)).toBe(true);
    await togglePauseAllChannels(queue);
    expect(isChannelPaused(queue, 2)).toBe(false);
  });
});

describe('fades', () => {
  const playing = async (config: Partial<QueueConfig> = {}): Promise<AudioQueue> => {
    const queue = setup(config);
    await queueAudio(queue, '/a.mp3');
    await flush();
    return queue;
  };

  test('pauseWithFade ramps to silence, pauses, and keeps the channel volume', async () => {
    const queue = await playing();
    await setChannelVolume(queue, 0, 0.8);
    const done = pauseWithFade(queue, FadeType.Linear, 0, 400);
    await advance(200);
    expect(audioAt(0).volume).toBeGreaterThan(0.2);
    expect(audioAt(0).volume).toBeLessThan(0.6);
    await advance(250);
    await done;
    expect(isChannelPaused(queue)).toBe(true);
    expect(audioAt(0).volume).toBe(0);
    expect(getChannelVolume(queue)).toBe(0.8);
  });

  test('resumeWithFade fades back to the channel volume with the remembered settings', async () => {
    const queue = await playing();
    await setChannelVolume(queue, 0, 0.8);
    const paused = pauseWithFade(queue, FadeType.Dramatic, 0, 300);
    await advance(400);
    await paused;
    const resumed = resumeWithFade(queue);
    await advance(150);
    expect(audioAt(0).volume).toBeGreaterThan(0);
    expect(audioAt(0).volume).toBeLessThan(0.8);
    await advance(200);
    await resumed;
    expect(audioAt(0).volume).toBeCloseTo(0.8);
    expect(isChannelPaused(queue)).toBe(false);
  });

  test('resuming during a fade-out cancels the pause (rapid toggle)', async () => {
    const queue = await playing();
    const pause = pauseWithFade(queue, FadeType.Linear, 0, 400);
    await advance(100);
    const resume = resumeWithFade(queue, FadeType.Linear, 0, 200);
    await advance(600);
    await Promise.all([pause, resume]);
    expect(isChannelPaused(queue)).toBe(false);
    expect(audioAt(0).paused).toBe(false);
    expect(audioAt(0).volume).toBeCloseTo(1);
  });

  test('a plain resume after a fade-pause restores full volume', async () => {
    const queue = await playing();
    const pause = pauseWithFade(queue, FadeType.Gentle, 0, 100);
    await advance(200);
    await pause;
    await resumeChannel(queue);
    expect(audioAt(0).volume).toBe(1);
  });

  test('a plain pause during a fade-out cancels the fade and pauses now', async () => {
    const queue = await playing();
    const fade = pauseWithFade(queue, FadeType.Linear, 0, 400);
    await advance(100);
    await pauseChannel(queue);
    await advance(500);
    await fade;
    expect(isChannelPaused(queue)).toBe(true);
  });

  test('resumeWithFade after an instant pause fades in from silence', async () => {
    const queue = await playing();
    await pauseChannel(queue);
    const resume = resumeWithFade(queue, FadeType.Linear, 0, 200);
    await flush();
    expect(audioAt(0).volume).toBeLessThan(0.2);
    await advance(300);
    await resume;
    expect(audioAt(0).volume).toBeCloseTo(1);
  });

  test('fades are no-ops on idle or already-paused channels', async () => {
    const queue = setup();
    await pauseWithFade(queue);
    await resumeWithFade(queue);
    await queueAudio(queue, '/a.mp3');
    await resumeWithFade(queue);
    await pauseChannel(queue);
    await pauseWithFade(queue);
    expect(isChannelPaused(queue)).toBe(true);
  });

  test('togglePauseWithFade and the *All* variants', async () => {
    const queue = await playing();
    await queueAudio(queue, '/b.mp3', 1);
    await flush();
    let step = togglePauseWithFade(queue, FadeType.Linear, 0, 100);
    await advance(200);
    await step;
    expect(isChannelPaused(queue, 0)).toBe(true);
    step = togglePauseWithFade(queue, FadeType.Linear, 0, 100);
    await advance(200);
    await step;
    expect(isChannelPaused(queue, 0)).toBe(false);
    step = togglePauseAllWithFade(queue, FadeType.Linear, 100);
    await advance(200);
    await step;
    expect(getAllChannelsPauseState(queue)).toEqual([true, true]);
    step = togglePauseAllWithFade(queue, FadeType.Linear, 100);
    await advance(200);
    await step;
    expect(getAllChannelsPauseState(queue)).toEqual([false, false]);
    step = pauseAllWithFade(queue);
    await advance(1000);
    await step;
    step = resumeAllWithFade(queue);
    await advance(1000);
    await step;
    expect(getAllChannelsPauseState(queue)).toEqual([false, false]);
  });

  test('fades finish even when timers are throttled to once per second', async () => {
    const queue = await playing();
    const pause = pauseWithFade(queue, FadeType.Linear, 0, 300);
    jest.advanceTimersByTime(1000);
    await flush();
    await pause;
    expect(isChannelPaused(queue)).toBe(true);
  });
});

describe('volume', () => {
  test('setChannelVolume applies instantly and clamps', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    await setChannelVolume(queue, 0, 0.25);
    expect(audioAt(0).volume).toBe(0.25);
    await setChannelVolume(queue, 0, 5);
    expect(getChannelVolume(queue)).toBe(1);
    await setChannelVolume(queue, 0, NaN);
    expect(getChannelVolume(queue)).toBe(1);
  });

  test('transitions work on idle channels and apply to the next item', async () => {
    const queue = setup();
    const done = setChannelVolume(queue, 0, 0.3, 200, EasingType.Linear);
    await advance(300);
    await done;
    expect(getChannelVolume(queue)).toBeCloseTo(0.3);
    await queueAudio(queue, '/a.mp3');
    expect(audioAt(0).volume).toBeCloseTo(0.3);
  });

  test('transitionVolume animates, cancelVolumeTransition stops midway', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    const done = transitionVolume(queue, 0, 0, 400, EasingType.Linear);
    await advance(200);
    cancelVolumeTransition(queue, 0);
    await done;
    const volume = getChannelVolume(queue);
    expect(volume).toBeGreaterThan(0.3);
    expect(volume).toBeLessThan(0.7);
    await advance(400);
    expect(getChannelVolume(queue)).toBe(volume);
    cancelVolumeTransition(queue, 9);
  });

  test('a new transition replaces a running one', async () => {
    const queue = setup();
    const first = transitionVolume(queue, 0, 0, 400);
    await advance(100);
    const second = transitionVolume(queue, 0, 1, 100);
    await advance(500);
    await Promise.all([first, second]);
    expect(getChannelVolume(queue)).toBe(1);
  });

  test('cancelAllVolumeTransitions stops every channel', async () => {
    const queue = setup();
    const a = transitionVolume(queue, 0, 0, 400);
    const b = transitionVolume(queue, 1, 0, 400);
    await advance(100);
    cancelAllVolumeTransitions(queue);
    await Promise.all([a, b]);
    expect(getChannelVolume(queue, 0)).toBeGreaterThan(0);
    expect(getChannelVolume(queue, 1)).toBeGreaterThan(0);
  });

  test('getAllChannelsVolume and setAllChannelsVolume', async () => {
    const queue = setup();
    await setChannelVolume(queue, 2, 0.5);
    expect(getAllChannelsVolume(queue)).toEqual([1, 1, 0.5]);
    await setAllChannelsVolume(queue, 0.2);
    expect(getAllChannelsVolume(queue)).toEqual([1, 1, 0.2]);
    expect(getAllChannelsVolume(setup())).toEqual([]);
  });

  test('global volume multiplies every channel, including per-item volumes', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3', 0, { volume: 0.4 });
    await setGlobalVolume(queue, 0.5);
    expect(getGlobalVolume(queue)).toBe(0.5);
    expect(audioAt(0).volume).toBeCloseTo(0.2);
    await queueAudio(queue, '/b.mp3', 1);
    expect(audioAt(1).volume).toBeCloseTo(0.5);
    await setGlobalVolume(queue, -3);
    expect(getGlobalVolume(queue)).toBe(0);
  });
});

describe('volume ducking', () => {
  const duck = (queue: AudioQueue): void =>
    setVolumeDucking(queue, {
      duckTransitionDuration: 100,
      duckingVolume: 0.2,
      priorityChannel: 1,
      priorityVolume: 0.9,
      restoreTransitionDuration: 100
    });

  test('ducks other channels while the priority channel has audio, then restores', async () => {
    const queue = setup();
    duck(queue);
    await queueAudio(queue, '/music.mp3', 0);
    await flush();
    await queueAudio(queue, '/voice.mp3', 1);
    expect(audioAt(1).playCalls).toBe(1);
    await advance(200);
    expect(audioAt(0).volume).toBeCloseTo(0.2);
    expect(audioAt(1).volume).toBeCloseTo(0.9);
    audioAt(1).finish();
    await advance(200);
    expect(audioAt(0).volume).toBeCloseTo(1);
  });

  test('channels that start while ducked are ducked too', async () => {
    const queue = setup();
    duck(queue);
    await queueAudio(queue, '/voice.mp3', 1);
    await advance(200);
    await queueAudio(queue, '/sfx.mp3', 2);
    expect(audioAt(1).volume).toBeCloseTo(0.2);
  });

  test('ducking never delays the priority sound', async () => {
    const queue = setup();
    duck(queue);
    await queueAudio(queue, '/music.mp3', 0);
    await queueAudio(queue, '/voice.mp3', 1);
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('clearVolumeDucking restores everything', async () => {
    const queue = setup();
    duck(queue);
    await queueAudio(queue, '/music.mp3', 0);
    await queueAudio(queue, '/voice.mp3', 1);
    await advance(200);
    clearVolumeDucking(queue);
    await advance(300);
    expect(audioAt(0).volume).toBeCloseTo(1);
  });

  test('uses default transition settings when none are given', async () => {
    const queue = setup();
    setVolumeDucking(queue, { duckingVolume: 0.5, priorityChannel: 1, priorityVolume: 1 });
    await queueAudio(queue, '/music.mp3', 0);
    await queueAudio(queue, '/voice.mp3', 1);
    await advance(100);
    expect(audioAt(0).volume).toBeGreaterThan(0.5);
    await advance(300);
    expect(audioAt(0).volume).toBeCloseTo(0.5);
  });

  test('rejects an invalid priority channel', () => {
    expect(() =>
      setVolumeDucking(setup(), { duckingVolume: 0.2, priorityChannel: 99, priorityVolume: 1 })
    ).toThrow(RangeError);
  });

  test('destroying the priority channel restores the others', async () => {
    const queue = setup();
    duck(queue);
    await queueAudio(queue, '/music.mp3', 0);
    await queueAudio(queue, '/voice.mp3', 1);
    await advance(200);
    await destroyChannel(queue, 1);
    await advance(200);
    expect(audioAt(0).volume).toBeCloseTo(1);
  });
});

describe('Web Audio routing', () => {
  beforeEach(() => installFakeAudioContext());

  describe('channel analyser', () => {
    const context = (): FakeAudioContext => FakeAudioContext.instances[0] as FakeAudioContext;

    test('routes the channel through one analyser that plays into the speakers', async () => {
      const queue = setup({ webAudio: 'auto' });
      const analyser = getChannelAnalyser(queue, 0);
      expect(analyser).toBe(context().analysers[0]);
      expect(context().analysers[0]?.connect).toHaveBeenCalledWith(context().destination);
      await queueAudio(queue, '/a.mp3');
      expect(context().panners[0]?.connect).toHaveBeenCalledWith(analyser);
      expect(getChannelAnalyser(queue, 0)).toBe(analyser);
      expect(context().analysers).toHaveLength(1);
    });

    test('a playing item is routed into the analyser when it is requested', async () => {
      const queue = setup({ webAudio: 'auto' });
      await queueAudio(queue, '/a.mp3');
      await flush();
      expect(FakeAudioContext.instances).toHaveLength(0);
      const analyser = getChannelAnalyser(queue, 0);
      expect(context().sources).toHaveLength(1);
      expect(context().panners[0]?.connect).toHaveBeenCalledWith(analyser);
    });

    test('an already-routed item is moved from the speakers to the analyser', async () => {
      const queue = setup({ webAudio: 'force' });
      await queueAudio(queue, '/a.mp3');
      const panner = context().panners[0];
      expect(panner?.connect).toHaveBeenCalledWith(context().destination);
      const analyser = getChannelAnalyser(queue, 0);
      expect(panner?.disconnect).toHaveBeenCalled();
      expect(panner?.connect).toHaveBeenLastCalledWith(analyser);
    });

    test('each channel has its own analyser; destroying the channel disconnects it', async () => {
      const queue = setup({ webAudio: 'auto' });
      const first = getChannelAnalyser(queue, 0);
      const second = getChannelAnalyser(queue, 1);
      expect(first).not.toBe(second);
      await destroyChannel(queue, 0);
      expect(context().analysers[0]?.disconnect).toHaveBeenCalled();
    });

    test("undefined with webAudio 'off' or without Web Audio", () => {
      expect(getChannelAnalyser(setup({ webAudio: 'off' }), 0)).toBeUndefined();
      removeAudioContext();
      expect(getChannelAnalyser(setup({ webAudio: 'auto' }), 0)).toBeUndefined();
    });

    test('cross-origin audio without CORS is not routed, with a warning', async () => {
      const warn = jest.fn();
      const queue = setup({ logger: { error: jest.fn(), warn }, webAudio: 'auto' });
      getChannelAnalyser(queue, 0);
      await queueAudio(queue, 'https://cdn.other.com/a.mp3');
      expect(context().sources).toHaveLength(0);
      expect(String(callArg(warn))).toMatch(/cannot pan or analyse a\.mp3/);
    });
  });

  describe('stereo panning', () => {
    const context = (): FakeAudioContext => FakeAudioContext.instances[0] as FakeAudioContext;

    test('a panned channel routes through Web Audio on desktop, with the gain node in control', async () => {
      const queue = setup({ webAudio: 'auto' });
      setChannelPan(queue, 0, -0.5);
      await queueAudio(queue, '/a.mp3');
      expect(context().panners[0]?.pan.value).toBe(-0.5);
      expect(audioAt(0).volume).toBe(1);
      await setChannelVolume(queue, 0, 0.4);
      expect(context().gains[0]?.gain.value).toBeCloseTo(0.4);
      expect(audioAt(0).volume).toBe(1);
    });

    test('panning a playing item routes it then, keeping its volume', async () => {
      const queue = setup({ webAudio: 'auto' });
      await setChannelVolume(queue, 0, 0.3);
      await queueAudio(queue, '/a.mp3');
      await flush();
      expect(FakeAudioContext.instances).toHaveLength(0);
      setChannelPan(queue, 0, 1);
      expect(context().sources).toHaveLength(1);
      expect(context().panners[0]?.pan.value).toBe(1);
      expect(context().gains[0]?.gain.value).toBeCloseTo(0.3);
      expect(audioAt(0).volume).toBe(1);
      setChannelPan(queue, 0, 0.25);
      expect(context().sources).toHaveLength(1);
      expect(context().panners[0]?.pan.value).toBe(0.25);
    });

    test('back to center keeps the route; unpanned channels stay unrouted', async () => {
      const queue = setup({ webAudio: 'auto' });
      setChannelPan(queue, 0, 0.5);
      await queueAudio(queue, '/a.mp3', 0);
      await queueAudio(queue, '/b.mp3', 1);
      setChannelPan(queue, 0, 0);
      expect(context().sources).toHaveLength(1);
      expect(context().panners[0]?.pan.value).toBe(0);
    });

    test('cross-origin audio without CORS plays centered, with a warning', async () => {
      const warn = jest.fn();
      const queue = setup({ logger: { error: jest.fn(), warn }, webAudio: 'auto' });
      setChannelPan(queue, 0, -1);
      await queueAudio(queue, 'https://cdn.other.com/a.mp3');
      expect(FakeAudioContext.instances[0]?.sources ?? []).toHaveLength(0);
      expect(String(callArg(warn))).toMatch(
        /cannot pan or analyse a\.mp3: cross-origin without CORS/
      );
      await queueAudio(queue, 'https://cdn.other.com/b.mp3', 1, { crossOrigin: 'anonymous' });
      setChannelPan(queue, 1, 1);
      expect(context().panners[0]?.pan.value).toBe(1);
    });

    test("webAudio 'off' never routes", async () => {
      const queue = setup({ webAudio: 'off' });
      setChannelPan(queue, 0, 1);
      await queueAudio(queue, '/a.mp3');
      expect(FakeAudioContext.instances).toHaveLength(0);
      expect(getChannelPan(queue, 0)).toBe(1);
    });

    test('browsers without StereoPannerNode still route volume and do not throw', async () => {
      FakeAudioContext.hasStereoPanner = false;
      const queue = setup({ webAudio: 'force' });
      setChannelPan(queue, 0, 1);
      await queueAudio(queue, '/a.mp3');
      expect(context().sources).toHaveLength(1);
      expect(context().panners).toHaveLength(0);
      expect(() => setChannelPan(queue, 0, -1)).not.toThrow();
    });

    test('released items disconnect their panner', async () => {
      const queue = setup({ webAudio: 'auto' });
      setChannelPan(queue, 0, 1);
      await queueAudio(queue, '/a.mp3');
      await stopAllAudioInChannel(queue, 0);
      expect(context().panners[0]?.disconnect).toHaveBeenCalled();
    });

    test('positions are clamped; non-numbers and bad channels are rejected', () => {
      const queue = setup();
      expect(getChannelPan(queue)).toBe(0);
      expect(getChannelPan(queue, 9)).toBe(0);
      setChannelPan(queue, 0, 3);
      expect(getChannelPan(queue, 0)).toBe(1);
      setChannelPan(queue, 0, -3);
      expect(getChannelPan(queue, 0)).toBe(-1);
      expect(() => setChannelPan(queue, 0, Number.NaN)).toThrow(RangeError);
      expect(() => setChannelPan(queue, -1, 0)).toThrow(RangeError);
    });
  });

  test('force mode routes through one shared context and controls gain, not element volume', async () => {
    const queue = setup({ webAudio: 'force' });
    await queueAudio(queue, '/a.mp3', 0);
    await queueAudio(queue, '/b.mp3', 1);
    await setChannelVolume(queue, 0, 0.3);
    expect(FakeAudioContext.instances).toHaveLength(1);
    const context = FakeAudioContext.instances[0] as FakeAudioContext;
    expect(context.gains[0]?.gain.value).toBeCloseTo(0.3);
    expect(audioAt(0).volume).toBe(1);
  });

  test('auto mode on iOS leaves full-volume audio native (lock screen and background play work)', async () => {
    setUserAgent(IPHONE_UA);
    const queue = setup({ webAudio: 'auto' });
    await queueAudio(queue, '/music.mp3', 0);
    await flush();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  test('auto mode on iOS routes once the volume is between 0 and 1: same-origin and CORS only', async () => {
    setUserAgent(IPHONE_UA);
    const queue = setup({ webAudio: 'auto' });
    await queueAudio(queue, '/same-origin.mp3', 0, { volume: 0.5 });
    await queueAudio(queue, 'https://cdn.other.com/x.mp3', 1, { volume: 0.5 });
    await queueAudio(queue, 'https://cors.other.com/y.mp3', 2, { crossOrigin: 'anonymous' });
    const context = FakeAudioContext.instances[0] as FakeAudioContext;
    expect(context.sources).toHaveLength(1);
    await setChannelVolume(queue, 2, 0.3); // a playing item is routed when its volume changes
    expect(context.sources).toHaveLength(2);
    expect(context.gains[1]?.gain.value).toBeCloseTo(0.3);
  });

  test('on iOS, muting uses the element muted flag instead of Web Audio', async () => {
    setUserAgent(IPHONE_UA);
    const queue = setup({ webAudio: 'auto' });
    await queueAudio(queue, '/a.mp3');
    setMuted(queue, true);
    expect(audioAt(0).muted).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(0);
    setMuted(queue, false);
    expect(audioAt(0).muted).toBe(false);
  });

  describe('on iOS, resuming reloads the element and seeks back (iOS skips or replays otherwise)', () => {
    /** Plays /a.mp3 on iOS, moves to 3 s and pauses; the next play() does not start by itself. */
    const pausedAtThreeSeconds = async (options: AudioQueueOptions = {}): Promise<AudioQueue> => {
      setUserAgent(IPHONE_UA);
      const queue = setup({ webAudio: 'auto' });
      await queueAudio(queue, '/a.mp3', 0, options);
      await flush();
      audioAt(0).tick(3);
      await pauseChannel(queue, 0);
      audioAt(0).playBehavior = 'resolve-silently';
      return queue;
    };

    test.each([
      ['at full volume', {}],
      ['through Web Audio', { volume: 0.5 }]
    ])('%s', async (_, options) => {
      const queue = await pausedAtThreeSeconds(options);
      const loads = audioAt(0).loadCalls;
      await resumeChannel(queue, 0);
      expect(audioAt(0).loadCalls).toBe(loads + 1);
      // While it reloads, the element reads 0; the queue still reports where it is resuming.
      expect(audioAt(0).currentTime).toBe(0);
      expect(getCurrentAudioInfo(queue, 0)).toEqual(
        expect.objectContaining({ currentTime: 3000, duration: 10000 })
      );
      audioAt(0).startPlaying();
      expect(audioAt(0).currentTime).toBe(3);
      expect(getCurrentAudioInfo(queue, 0)?.currentTime).toBe(3000);
    });

    test('pausing and resuming again before the reload finishes keeps the position', async () => {
      const queue = await pausedAtThreeSeconds();
      await resumeChannel(queue, 0);
      await pauseChannel(queue, 0);
      await resumeChannel(queue, 0);
      audioAt(0).startPlaying();
      expect(audioAt(0).currentTime).toBe(3);
    });

    test('a seek while reloading moves where it resumes', async () => {
      const queue = await pausedAtThreeSeconds();
      await resumeChannel(queue, 0);
      expect(seekBy(queue, 0, 2000)).toBe(true);
      expect(getCurrentAudioInfo(queue, 0)?.currentTime).toBe(5000);
      audioAt(0).startPlaying();
      expect(audioAt(0).currentTime).toBe(5);
    });

    test('other platforms resume with play() alone', async () => {
      const queue = setup();
      await queueAudio(queue, '/a.mp3');
      await flush();
      audioAt(0).tick(3);
      await pauseChannel(queue, 0);
      const loads = audioAt(0).loadCalls;
      await resumeChannel(queue, 0);
      expect(audioAt(0).loadCalls).toBe(loads);
      expect(audioAt(0).currentTime).toBe(3);
    });
  });

  test('desktop resumes without re-seeking', async () => {
    const queue = setup({ webAudio: 'force' });
    await queueAudio(queue, '/a.mp3');
    await flush();
    audioAt(0).tick(3);
    await pauseChannel(queue, 0);
    const seeks = jest.spyOn(audioAt(0), 'currentTime', 'set');
    await resumeChannel(queue, 0);
    expect(seeks).not.toHaveBeenCalled();
  });

  test('auto mode on desktop does not use Web Audio', async () => {
    const queue = setup({ webAudio: 'auto' });
    await queueAudio(queue, '/a.mp3');
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  test('released items disconnect their nodes', async () => {
    const queue = setup({ webAudio: 'force' });
    await queueAudio(queue, '/a.mp3');
    await stopAllAudioInChannel(queue);
    const context = FakeAudioContext.instances[0] as FakeAudioContext;
    expect(context.sources[0]?.disconnect).toHaveBeenCalled();
  });

  test('falls back to element volume when routing fails', async () => {
    FakeAudioContext.failSourceCreation = true;
    const queue = setup({ webAudio: 'force' });
    await queueAudio(queue, '/a.mp3');
    await setChannelVolume(queue, 0, 0.4);
    expect(audioAt(0).volume).toBe(0.4);
  });

  test('unlockAudio resumes the shared context', async () => {
    const queue = setup({ webAudio: 'force' });
    await queueAudio(queue, '/a.mp3');
    const context = FakeAudioContext.instances[0] as FakeAudioContext;
    context.state = 'suspended';
    unlockAudio(queue);
    expect(context.resume).toHaveBeenCalledTimes(2);
  });
});

describe('information', () => {
  test('getCurrentAudioInfo describes the current item', async () => {
    const queue = setup();
    expect(getCurrentAudioInfo(queue)).toBeNull();
    await queueAudio(queue, '/a.mp3', 0, { loop: true });
    await queueAudio(queue, '/b.mp3');
    await flush();
    audioAt(0).currentTime = 2.5;
    expect(getCurrentAudioInfo(queue)).toEqual({
      currentTime: 2500,
      duration: 10000,
      fileName: 'a.mp3',
      id: 1,
      isLoading: false,
      isLooping: true,
      isPaused: false,
      isPlaying: true,
      metadata: undefined,
      playbackRate: 1,
      progress: 0.25,
      remainingInQueue: 1,
      src: 'http://localhost/a.mp3',
      volume: 1
    });
  });

  test('getAllChannelsInfo is indexed by channel', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3', 1);
    const info = getAllChannelsInfo(queue);
    expect(info).toHaveLength(2);
    expect(info[0]).toBeNull();
    expect(info[1]?.fileName).toBe('a.mp3');
  });

  test('getQueueSnapshot returns null for unused channels and -1 index when empty', async () => {
    const queue = setup();
    expect(getQueueSnapshot(queue, 4)).toBeNull();
    await setChannelVolume(queue, 4, 0.5);
    expect(getQueueSnapshot(queue, 4)).toEqual({
      channelNumber: 4,
      currentIndex: -1,
      isPaused: false,
      items: [],
      totalItems: 0,
      volume: 0.5
    });
  });
});
