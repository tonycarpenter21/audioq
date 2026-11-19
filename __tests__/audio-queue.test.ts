import { AudioQueue, createAudioQueue } from '../src/audio-queue';
import type { AudioInfo, QueueConfig, QueueSnapshot } from '../src/types';
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
    expect(a).toBeInstanceOf(AudioQueue);
    await a.queueAudio('/a.mp3');
    expect(a.getQueueLength()).toBe(1);
    expect(b.getQueueLength()).toBe(0);
  });

  test('validates configuration', () => {
    expect(() => createAudioQueue({ maxChannels: 0 })).toThrow(RangeError);
  });
});

describe('configuration', () => {
  test('setQueueConfig merges, getQueueConfig returns a copy', () => {
    const queue = setup();
    queue.setQueueConfig({ defaultMaxQueueSize: 4 });
    const config = queue.getQueueConfig();
    expect(config.defaultMaxQueueSize).toBe(4);
    config.defaultMaxQueueSize = 99;
    expect(queue.getQueueConfig().defaultMaxQueueSize).toBe(4);
  });

  test('setChannelQueueLimit validates input', () => {
    const queue = setup();
    expect(() => queue.setChannelQueueLimit(0, 0)).toThrow(RangeError);
    expect(() => queue.setChannelQueueLimit(-1, 2)).toThrow(RangeError);
    expect(() => queue.setChannelQueueLimit(0, undefined)).not.toThrow();
  });

  test('getWebAudioSupport reflects the configured mode', () => {
    installFakeAudioContext();
    expect(setup({ webAudio: 'force' }).getWebAudioSupport().usingWebAudio).toBe(true);
    expect(setup({ webAudio: 'off' }).getWebAudioSupport().usingWebAudio).toBe(false);
  });
});

describe('queueAudio', () => {
  test('starts an idle channel immediately and returns a handle', async () => {
    const queue = setup();
    const item = await queue.queueAudio('/sfx/a.mp3');
    expect(item.channelNumber).toBe(0);
    expect(item.src).toBe('http://localhost/sfx/a.mp3');
    expect(audioAt(0).playCalls).toBe(1);
    await expect(item.started).resolves.toBe(true);
  });

  test('waits for the current item before playing the next', async () => {
    const queue = setup();
    const first = await queue.queueAudio('/a.mp3');
    const second = await queue.queueAudio('/b.mp3');
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
    const a = await queue.queueAudio('/a.mp3');
    const b = await queue.queueAudio('/b.mp3');
    expect(a.id).not.toBe(b.id);
    expect(queue.getQueueSnapshot()?.items.map((i) => i.id)).toEqual([a.id, b.id]);
  });

  test.each(['', '   ', 42, null])('rejects invalid URL %p', async (url) => {
    await expect(setup().queueAudio(url as string)).rejects.toThrow(TypeError);
  });

  test.each([
    'blob:http://localhost/9b1c',
    'data:audio/wav;base64,UklGRiQAAABXQVZF',
    '../sounds/beep.mp3',
    'capacitor://localhost/beep.mp3',
    '/api/tts?text=hi'
  ])('accepts legitimate source %s', async (url) => {
    await expect(setup().queueAudio(url)).resolves.toBeDefined();
  });

  test.each([-1, 64, 1.5, NaN])('rejects channel %p with RangeError', async (channel) => {
    await expect(setup().queueAudio('/a.mp3', channel)).rejects.toThrow(RangeError);
  });

  test('respects a custom maxChannels', async () => {
    const queue = setup({ maxChannels: 2 });
    await expect(queue.queueAudio('/a.mp3', 1)).resolves.toBeDefined();
    await expect(queue.queueAudio('/a.mp3', 2)).rejects.toThrow(RangeError);
  });

  test('explains when HTMLAudioElement is missing', async () => {
    const saved = (globalThis as { Audio?: unknown }).Audio;
    delete (globalThis as { Audio?: unknown }).Audio;
    try {
      await expect(setup().queueAudio('/a.mp3')).rejects.toThrow(/browser environment/);
    } finally {
      (globalThis as { Audio?: unknown }).Audio = saved;
    }
  });

  test('addToFront inserts right after the current item', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
    await queue.queueAudio('/c.mp3', 0, { addToFront: true });
    expect(names(queue.getQueueSnapshot())).toEqual(['a.mp3', 'c.mp3', 'b.mp3']);
  });

  test('addToFront on an empty channel just plays', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3', 0, { addToFront: true });
    expect(audioAt(0).playCalls).toBe(1);
  });

  test('queueAudioPriority is addToFront', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
    await queue.queueAudioPriority('/urgent.mp3', 0, { volume: 0.5 });
    expect(names(queue.getQueueSnapshot())).toEqual(['a.mp3', 'urgent.mp3', 'b.mp3']);
    expect(queue.getQueueItemInfo(1)?.volume).toBe(0.5);
  });

  test('applies loop, crossOrigin and item volume to the element', async () => {
    const queue = setup();
    await queue.setChannelVolume(0, 0.5);
    await queue.queueAudio('https://cdn.example.com/a.mp3', 0, {
      crossOrigin: 'anonymous',
      loop: true,
      volume: 0.4
    });
    const audio = audioAt(0);
    expect(audio.loop).toBe(true);
    expect(audio.crossOrigin).toBe('anonymous');
    expect(audio.volume).toBeCloseTo(0.2);
    expect(queue.getChannelVolume(0)).toBe(0.5);
  });

  test('clamps item volume', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3', 0, { volume: 7 });
    expect(queue.getQueueItemInfo(0)?.volume).toBe(1);
  });
});

describe('prefetching', () => {
  test('only the current and next item get elements', async () => {
    const queue = setup();
    for (const n of ['a', 'b', 'c', 'd']) await queue.queueAudio(`/${n}.mp3`);
    expect(FakeAudio.instances).toHaveLength(2);
    expect(FakeAudio.instances.every((audio) => audio.preload === 'auto')).toBe(true);
    audioAt(0).finish();
    await flush();
    expect(FakeAudio.instances).toHaveLength(3);
  });

  test('prefetchCount 0 creates only the current element', async () => {
    const queue = setup({ prefetchCount: 0 });
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
    expect(FakeAudio.instances).toHaveLength(1);
  });

  test('reordering pulls the new next item into the prefetch window', async () => {
    const queue = setup();
    for (const n of ['a', 'b', 'c']) await queue.queueAudio(`/${n}.mp3`);
    await queue.reorderQueue(2, 1);
    expect(FakeAudio.instances.map((a) => a.src.split('/').pop())).toContain('c.mp3');
  });
});

describe('queue limits', () => {
  test('rejects when the channel is full', async () => {
    const queue = setup({ defaultMaxQueueSize: 2 });
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
    await expect(queue.queueAudio('/c.mp3')).rejects.toThrow(/limit exceeded/);
  });

  test('per-call maxQueueSize applies to that call only', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    await expect(queue.queueAudio('/b.mp3', 0, { maxQueueSize: 1 })).rejects.toThrow();
    await expect(queue.queueAudio('/b.mp3')).resolves.toBeDefined();
  });

  test('setChannelQueueLimit limits one channel', async () => {
    const queue = setup();
    queue.setChannelQueueLimit(1, 1);
    await queue.queueAudio('/a.mp3', 1);
    await expect(queue.queueAudio('/b.mp3', 1)).rejects.toThrow();
    await expect(queue.queueAudio('/b.mp3', 2)).resolves.toBeDefined();
  });

  test('dropOldestWhenFull drops the oldest waiting item, never the current one', async () => {
    const queue = setup({ defaultMaxQueueSize: 2, dropOldestWhenFull: true });
    await queue.queueAudio('/a.mp3');
    const b = await queue.queueAudio('/b.mp3');
    await queue.queueAudio('/c.mp3');
    expect(names(queue.getQueueSnapshot())).toEqual(['a.mp3', 'c.mp3']);
    await expect(b.finished).resolves.toBe('removed');
  });

  test('dropOldestWhenFull still rejects when only the current item exists', async () => {
    const queue = setup({ defaultMaxQueueSize: 1, dropOldestWhenFull: true });
    await queue.queueAudio('/a.mp3');
    await expect(queue.queueAudio('/b.mp3')).rejects.toThrow();
  });

  test('warns through the logger unless warnings are off', async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const queue = createAudioQueue({ defaultMaxQueueSize: 1, logger });
    await queue.queueAudio('/a.mp3');
    await expect(queue.queueAudio('/b.mp3')).rejects.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('limit 1'));
    queue.setQueueConfig({ showQueueWarnings: false });
    await expect(queue.queueAudio('/b.mp3')).rejects.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('events', () => {
  test('start, complete and queue change fire in order with useful payloads', async () => {
    const queue = setup();
    const log: string[] = [];
    queue.onQueueChange(0, (s) => log.push(`queue:${s.totalItems}`));
    queue.onAudioStart(0, (i) => log.push(`start:${i.fileName}:${i.duration}`));
    queue.onAudioComplete(0, (i) =>
      log.push(`complete:${i.fileName}:${i.reason}:${i.remainingInQueue}`)
    );
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
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
    queue.onAudioStart(0, start);
    await queue.queueAudio('/a.mp3');
    await flush();
    await queue.pauseChannel();
    await queue.resumeChannel();
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
  });

  test('on* returns an unsubscribe that removes only that listener', async () => {
    const queue = setup();
    const a = jest.fn();
    const b = jest.fn();
    const offA = queue.onQueueChange(0, a);
    queue.onQueueChange(0, b);
    offA();
    await queue.queueAudio('/a.mp3');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  test('off* with a callback removes just that callback; without removes all', async () => {
    const queue = setup();
    const a = jest.fn();
    const b = jest.fn();
    queue.onAudioStart(0, a);
    queue.onAudioStart(0, b);
    queue.offAudioStart(0, a);
    await queue.queueAudio('/a.mp3');
    await flush();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    queue.offAudioStart(0);
    audioAt(0).finish();
    await queue.queueAudio('/b.mp3');
    await flush();
    expect(b).toHaveBeenCalledTimes(1);
  });

  test('pause and resume listeners receive (channel, info) and can be removed by callback', async () => {
    const queue = setup();
    const onPause = jest.fn();
    const onResume = jest.fn();
    queue.onAudioPause(2, onPause);
    queue.onAudioResume(2, onResume);
    await queue.queueAudio('/a.mp3', 2);
    await flush();
    await queue.pauseChannel(2);
    await queue.resumeChannel(2);
    expect(onPause).toHaveBeenCalledWith(2, expect.objectContaining({ fileName: 'a.mp3' }));
    expect(onResume).toHaveBeenCalledWith(2, expect.objectContaining({ isPaused: false }));
    queue.offAudioPause(2, onPause);
    queue.offAudioResume(2, onResume);
    await queue.pauseChannel(2);
    await queue.resumeChannel(2);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test('off* without a callback clears pause, resume, complete, progress, queue and error', () => {
    const queue = setup();
    const spies = Array.from({ length: 7 }, () => jest.fn());
    queue.onAudioPause(0, spies[0] as jest.Mock);
    queue.onAudioResume(0, spies[1] as jest.Mock);
    queue.onAudioComplete(0, spies[2] as jest.Mock);
    queue.onAudioProgress(0, spies[3] as jest.Mock);
    queue.onQueueChange(0, spies[4] as jest.Mock);
    queue.onAudioError(0, spies[5] as jest.Mock);
    queue.offAudioPause();
    queue.offAudioResume();
    queue.offAudioComplete();
    queue.offAudioProgress();
    queue.offQueueChange();
    queue.offAudioError();
    void queue.queueAudio('/a.mp3');
    spies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  test('subscribing validates the channel number', () => {
    const queue = setup();
    expect(() => queue.onAudioStart(-1, jest.fn())).toThrow(RangeError);
    expect(() => queue.onAudioPause(99, jest.fn())).toThrow(RangeError);
    expect(() => queue.onAudioResume(1.5, jest.fn())).toThrow(RangeError);
  });

  test('a throwing listener is logged and does not break playback', async () => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const queue = createAudioQueue({ logger });
    queue.onQueueChange(0, () => {
      throw new Error('listener bug');
    });
    await queue.queueAudio('/a.mp3');
    expect(logger.error).toHaveBeenCalledWith('audioq: error in event listener', expect.any(Error));
    expect(audioAt(0).playCalls).toBe(1);
  });

  test('progress reports position for the current item only', async () => {
    const queue = setup();
    const progress: AudioInfo[] = [];
    queue.onAudioProgress(0, (info) => progress.push(info));
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
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
    queue.onAudioError(0, errors);
    const a = await queue.queueAudio('/missing.mp3');
    await queue.queueAudio('/b.mp3');
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
    queue.onAudioError(0, errors);
    await queue.queueAudio('/one.mp3');
    const two = await queue.queueAudio('/two.mp3');
    await queue.queueAudio('/three.mp3');
    await flush();
    audioAt(1).fail(2, 'net::ERR_FAILED');
    await flush();
    expect(audioAt(1).playCalls).toBe(0);
    expect(audioAt(0).paused).toBe(false);
    expect(names(queue.getQueueSnapshot())).toEqual(['one.mp3', 'three.mp3']);
    expect(callArg(errors)).toMatchObject({
      errorType: AudioErrorType.Network,
      remainingInQueue: 1
    });
    await expect(two.finished).resolves.toBe('error');
  });

  test('media error without a message gets a descriptive one', async () => {
    const queue = setup();
    const errors = jest.fn();
    queue.onAudioError(0, errors);
    await queue.queueAudio('/a.mp3');
    audioAt(0).fail(3, '');
    await flush();
    expect(callArg(errors)).toMatchObject({ error: { message: 'Media error (decode)' } });
  });

  test('error events after an item was released are ignored', async () => {
    const queue = setup();
    const errors = jest.fn();
    queue.onAudioError(0, errors);
    await queue.queueAudio('/a.mp3');
    const audio = audioAt(0);
    await queue.stopAllAudioInChannel();
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
    queue.onAudioError(0, errors);
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
    await flush();
    expect(callArg(errors)).toMatchObject({ errorType: type });
    expect(names(queue.getQueueSnapshot())).not.toContain('a.mp3');
  });

  test('AbortError from play() is not an error', async () => {
    FakeAudio.defaultPlayBehavior = 'abort';
    const queue = setup();
    const errors = jest.fn();
    queue.onAudioError(0, errors);
    await queue.queueAudio('/a.mp3');
    await flush();
    expect(errors).not.toHaveBeenCalled();
    expect(queue.getQueueLength()).toBe(1);
  });

  test('a stale play() rejection after the item was stopped is ignored', async () => {
    FakeAudio.defaultPlayBehavior = 'hang';
    const queue = setup();
    const errors = jest.fn();
    queue.onAudioError(0, errors);
    await queue.queueAudio('/a.mp3');
    await queue.stopCurrentAudioInChannel();
    await flush();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('autoplay blocking', () => {
  test('keeps the queue, reports once, and plays on the next user gesture', async () => {
    FakeAudio.defaultPlayBehavior = 'not-allowed';
    const queue = setup();
    const errors = jest.fn();
    queue.onAudioError(0, errors);
    for (const n of ['a', 'b', 'c']) await queue.queueAudio(`/${n}.mp3`);
    await flush();
    await advance(60000, 1000);
    expect(queue.getQueueLength()).toBe(3);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(callArg(errors)).toMatchObject({ errorType: AudioErrorType.AutoplayBlocked });

    FakeAudio.defaultPlayBehavior = 'resolve';
    document.dispatchEvent(new Event('touchend'));
    await flush();
    expect(queue.getCurrentAudioInfo()?.isPlaying).toBe(true);
    const plays = audioAt(0).playCalls;
    document.dispatchEvent(new Event('keydown'));
    await flush();
    expect(audioAt(0).playCalls).toBe(plays);
  });

  test('unlockAudio retries blocked channels from your own handler', async () => {
    FakeAudio.defaultPlayBehavior = 'not-allowed';
    const queue = setup();
    await queue.queueAudio('/a.mp3', 3);
    await flush();
    FakeAudio.defaultPlayBehavior = 'resolve';
    queue.unlockAudio();
    await flush();
    expect(queue.getCurrentAudioInfo(3)?.isPlaying).toBe(true);
  });

  test('a paused blocked channel is not started by a gesture', async () => {
    FakeAudio.defaultPlayBehavior = 'not-allowed';
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    await flush();
    await queue.pauseChannel();
    FakeAudio.defaultPlayBehavior = 'resolve';
    const plays = audioAt(0).playCalls;
    queue.unlockAudio();
    await flush();
    expect(audioAt(0).playCalls).toBe(plays);
  });

  test('stopping a blocked channel removes the gesture listener', async () => {
    FakeAudio.defaultPlayBehavior = 'not-allowed';
    const remove = jest.spyOn(document, 'removeEventListener');
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    await flush();
    await queue.stopAllAudio();
    expect(remove).toHaveBeenCalledWith('mousedown', expect.any(Function), { capture: true });
  });
});

describe('load timeout', () => {
  test('skips an item that never starts', async () => {
    FakeAudio.defaultPlayBehavior = 'hang';
    const queue = setup({ loadTimeoutMs: 5000 });
    const errors = jest.fn();
    queue.onAudioError(0, errors);
    const a = await queue.queueAudio('/slow.mp3');
    await queue.queueAudio('/b.mp3');
    await advance(4999, 1000);
    expect(errors).not.toHaveBeenCalled();
    await advance(10, 10);
    expect(callArg(errors)).toMatchObject({ errorType: AudioErrorType.Timeout });
    await expect(a.finished).resolves.toBe('error');
  });

  test('does not fire once playback started', async () => {
    const queue = setup({ loadTimeoutMs: 1000 });
    const errors = jest.fn();
    queue.onAudioError(0, errors);
    await queue.queueAudio('/a.mp3');
    await flush();
    await advance(5000, 500);
    expect(errors).not.toHaveBeenCalled();
  });

  test('is suspended while paused', async () => {
    FakeAudio.defaultPlayBehavior = 'hang';
    const queue = setup({ loadTimeoutMs: 1000 });
    await queue.queueAudio('/a.mp3');
    await queue.pauseChannel();
    await advance(5000, 500);
    expect(queue.getQueueLength()).toBe(1);
  });

  test('can be disabled with 0', async () => {
    FakeAudio.defaultPlayBehavior = 'hang';
    const queue = setup({ loadTimeoutMs: 0 });
    await queue.queueAudio('/a.mp3');
    await advance(120000, 10000);
    expect(queue.getQueueLength()).toBe(1);
  });
});

describe('stopping and destroying', () => {
  test('stopCurrentAudioInChannel completes with "stopped", releases the element, plays next', async () => {
    const queue = setup();
    const complete = jest.fn();
    queue.onAudioComplete(0, complete);
    const a = await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
    await flush();
    const audio = audioAt(0);
    await queue.stopCurrentAudioInChannel();
    expect(callArg(complete)).toMatchObject({ reason: 'stopped', remainingInQueue: 1 });
    await expect(a.finished).resolves.toBe('stopped');
    expect(audio.src).toBe('');
    expect(audio.loadCalls).toBe(1);
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('stopCurrentAudioInChannel on an empty or unknown channel does nothing', async () => {
    const queue = setup();
    await expect(queue.stopCurrentAudioInChannel(5)).resolves.toBeUndefined();
  });

  test('stopAllAudioInChannel settles every handle and releases every element', async () => {
    const queue = setup();
    const complete = jest.fn();
    const changes = jest.fn();
    queue.onAudioComplete(0, complete);
    const handles = [];
    for (const n of ['a', 'b', 'c']) handles.push(await queue.queueAudio(`/${n}.mp3`));
    queue.onQueueChange(0, changes);
    await queue.stopAllAudioInChannel();
    expect(queue.getQueueLength()).toBe(0);
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
    await queue.queueAudio('/a.mp3', 0);
    await queue.queueAudio('/b.mp3', 5);
    await queue.stopAllAudio();
    expect(queue.getQueueLength(0) + queue.getQueueLength(5)).toBe(0);
  });

  test('stopping resets pause state', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    await queue.pauseChannel();
    await queue.stopAllAudioInChannel();
    expect(queue.isChannelPaused()).toBe(false);
    await queue.stopAllAudioInChannel(9);
  });

  test('destroyChannel removes listeners and settings; the channel can be reused', async () => {
    const queue = setup();
    const start = jest.fn();
    queue.onAudioStart(1, start);
    await queue.setChannelVolume(1, 0.3);
    await queue.destroyChannel(1);
    expect(queue.getQueueSnapshot(1)).toBeNull();
    expect(queue.getChannelVolume(1)).toBe(1);
    await queue.queueAudio('/a.mp3', 1);
    await flush();
    expect(start).not.toHaveBeenCalled();
  });

  test('destroyAllChannels closes the AudioContext and removes all listeners', async () => {
    installFakeAudioContext();
    const queue = setup({ webAudio: 'force' });
    const global = jest.fn();
    queue.onAudioStart(0, global);
    await queue.queueAudio('/a.mp3');
    await queue.destroyAllChannels();
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalled();
    await queue.queueAudio('/b.mp3');
    await flush();
    expect(global).toHaveBeenCalledTimes(1);
  });
});

describe('queue manipulation', () => {
  const filled = async (): Promise<AudioQueue> => {
    const queue = setup();
    for (const n of ['a', 'b', 'c', 'd']) await queue.queueAudio(`/${n}.mp3`);
    return queue;
  };

  test('removeQueuedItem removes a waiting item and settles its handle', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    const b = await queue.queueAudio('/b.mp3');
    const result = await queue.removeQueuedItem(1);
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
    const result = await queue.removeQueuedItem(slot);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(message);
  });

  test('manipulating a channel that does not exist fails cleanly', async () => {
    const queue = setup();
    expect((await queue.removeQueuedItem(1, 3)).error).toMatch(/does not exist/);
    expect((await queue.reorderQueue(1, 2, 3)).success).toBe(false);
    expect((await queue.swapQueueItems(1, 2, 3)).success).toBe(false);
  });

  test('reorderQueue moves items and rejects index 0', async () => {
    const queue = await filled();
    const result = await queue.reorderQueue(3, 1);
    expect(names(result.updatedQueue ?? null)).toEqual(['a.mp3', 'd.mp3', 'b.mp3', 'c.mp3']);
    expect((await queue.reorderQueue(1, 0)).error).toMatch(/move to the currently playing/);
    expect((await queue.reorderQueue(0, 1)).success).toBe(false);
    expect((await queue.reorderQueue(1, 1)).success).toBe(true);
  });

  test('swapQueueItems swaps waiting items', async () => {
    const queue = await filled();
    const result = await queue.swapQueueItems(1, 3);
    expect(names(result.updatedQueue ?? null)).toEqual(['a.mp3', 'd.mp3', 'c.mp3', 'b.mp3']);
    expect((await queue.swapQueueItems(0, 2)).success).toBe(false);
    expect((await queue.swapQueueItems(1, 7)).success).toBe(false);
    expect((await queue.swapQueueItems(2, 2)).success).toBe(true);
  });

  test('clearQueueAfterCurrent keeps only the current item', async () => {
    const queue = await filled();
    const result = await queue.clearQueueAfterCurrent();
    expect(names(result.updatedQueue ?? null)).toEqual(['a.mp3']);
    expect((await queue.clearQueueAfterCurrent()).success).toBe(true);
    const missing = await queue.clearQueueAfterCurrent(7);
    expect(missing.updatedQueue).toMatchObject({ currentIndex: -1, totalItems: 0 });
  });

  test('getQueueItemInfo and getQueueLength', async () => {
    const queue = await filled();
    expect(queue.getQueueLength()).toBe(4);
    expect(queue.getQueueLength(9)).toBe(0);
    expect(queue.getQueueItemInfo(2)?.fileName).toBe('c.mp3');
    expect(queue.getQueueItemInfo(10)).toBeNull();
    expect(queue.getQueueItemInfo(0, 9)).toBeNull();
  });
});

describe('pause and resume', () => {
  test('pauseChannel / resumeChannel / isChannelPaused', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    await flush();
    await queue.pauseChannel();
    expect(audioAt(0).paused).toBe(true);
    expect(queue.isChannelPaused()).toBe(true);
    await queue.pauseChannel();
    await queue.resumeChannel();
    expect(audioAt(0).paused).toBe(false);
    expect(queue.isChannelPaused()).toBe(false);
    await queue.resumeChannel();
    expect(queue.isChannelPaused(9)).toBe(false);
  });

  test('pause before playback starts prevents it; resume starts it', async () => {
    FakeAudio.defaultPlayBehavior = 'resolve-silently';
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    await queue.pauseChannel();
    expect(audioAt(0).paused).toBe(true);
    FakeAudio.defaultPlayBehavior = 'resolve';
    await queue.resumeChannel();
    await flush();
    expect(queue.getCurrentAudioInfo()?.isPlaying).toBe(true);
  });

  test('items queued on a paused channel wait; finishing resets pause', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    await queue.pauseChannel();
    await queue.queueAudio('/b.mp3');
    expect(audioAt(1).playCalls).toBe(0);
    await queue.stopCurrentAudioInChannel();
    expect(queue.isChannelPaused()).toBe(false);
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('togglePauseChannel flips state; empty channels are ignored', async () => {
    const queue = setup();
    await queue.togglePauseChannel();
    await queue.queueAudio('/a.mp3');
    await queue.togglePauseChannel();
    expect(queue.isChannelPaused()).toBe(true);
    await queue.togglePauseChannel();
    expect(queue.isChannelPaused()).toBe(false);
  });

  test('pauseAll / resumeAll / togglePauseAll / getAllChannelsPauseState', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3', 0);
    await queue.queueAudio('/b.mp3', 2);
    await queue.pauseAllChannels();
    expect(queue.getAllChannelsPauseState()).toEqual([true, false, true]);
    await queue.resumeAllChannels();
    expect(queue.getAllChannelsPauseState()).toEqual([false, false, false]);
    await queue.togglePauseAllChannels();
    expect(queue.isChannelPaused(2)).toBe(true);
    await queue.togglePauseAllChannels();
    expect(queue.isChannelPaused(2)).toBe(false);
  });
});

describe('fades', () => {
  const playing = async (config: Partial<QueueConfig> = {}): Promise<AudioQueue> => {
    const queue = setup(config);
    await queue.queueAudio('/a.mp3');
    await flush();
    return queue;
  };

  test('pauseWithFade ramps to silence, pauses, and keeps the channel volume', async () => {
    const queue = await playing();
    await queue.setChannelVolume(0, 0.8);
    const done = queue.pauseWithFade(FadeType.Linear, 0, 400);
    await advance(200);
    expect(audioAt(0).volume).toBeGreaterThan(0.2);
    expect(audioAt(0).volume).toBeLessThan(0.6);
    await advance(250);
    await done;
    expect(queue.isChannelPaused()).toBe(true);
    expect(audioAt(0).volume).toBe(0);
    expect(queue.getChannelVolume()).toBe(0.8);
  });

  test('resumeWithFade fades back to the channel volume with the remembered settings', async () => {
    const queue = await playing();
    await queue.setChannelVolume(0, 0.8);
    const paused = queue.pauseWithFade(FadeType.Dramatic, 0, 300);
    await advance(400);
    await paused;
    const resumed = queue.resumeWithFade();
    await advance(150);
    expect(audioAt(0).volume).toBeGreaterThan(0);
    expect(audioAt(0).volume).toBeLessThan(0.8);
    await advance(200);
    await resumed;
    expect(audioAt(0).volume).toBeCloseTo(0.8);
    expect(queue.isChannelPaused()).toBe(false);
  });

  test('resuming during a fade-out cancels the pause (rapid toggle)', async () => {
    const queue = await playing();
    const pause = queue.pauseWithFade(FadeType.Linear, 0, 400);
    await advance(100);
    const resume = queue.resumeWithFade(FadeType.Linear, 0, 200);
    await advance(600);
    await Promise.all([pause, resume]);
    expect(queue.isChannelPaused()).toBe(false);
    expect(audioAt(0).paused).toBe(false);
    expect(audioAt(0).volume).toBeCloseTo(1);
  });

  test('a plain resume after a fade-pause restores full volume', async () => {
    const queue = await playing();
    const pause = queue.pauseWithFade(FadeType.Gentle, 0, 100);
    await advance(200);
    await pause;
    await queue.resumeChannel();
    expect(audioAt(0).volume).toBe(1);
  });

  test('a plain pause during a fade-out cancels the fade and pauses now', async () => {
    const queue = await playing();
    const fade = queue.pauseWithFade(FadeType.Linear, 0, 400);
    await advance(100);
    await queue.pauseChannel();
    await advance(500);
    await fade;
    expect(queue.isChannelPaused()).toBe(true);
  });

  test('resumeWithFade after an instant pause fades in from silence', async () => {
    const queue = await playing();
    await queue.pauseChannel();
    const resume = queue.resumeWithFade(FadeType.Linear, 0, 200);
    await flush();
    expect(audioAt(0).volume).toBeLessThan(0.2);
    await advance(300);
    await resume;
    expect(audioAt(0).volume).toBeCloseTo(1);
  });

  test('fades are no-ops on idle or already-paused channels', async () => {
    const queue = setup();
    await queue.pauseWithFade();
    await queue.resumeWithFade();
    await queue.queueAudio('/a.mp3');
    await queue.resumeWithFade();
    await queue.pauseChannel();
    await queue.pauseWithFade();
    expect(queue.isChannelPaused()).toBe(true);
  });

  test('togglePauseWithFade and the *All* variants', async () => {
    const queue = await playing();
    await queue.queueAudio('/b.mp3', 1);
    await flush();
    let step = queue.togglePauseWithFade(FadeType.Linear, 0, 100);
    await advance(200);
    await step;
    expect(queue.isChannelPaused(0)).toBe(true);
    step = queue.togglePauseWithFade(FadeType.Linear, 0, 100);
    await advance(200);
    await step;
    expect(queue.isChannelPaused(0)).toBe(false);
    step = queue.togglePauseAllWithFade(FadeType.Linear, 100);
    await advance(200);
    await step;
    expect(queue.getAllChannelsPauseState()).toEqual([true, true]);
    step = queue.togglePauseAllWithFade(FadeType.Linear, 100);
    await advance(200);
    await step;
    expect(queue.getAllChannelsPauseState()).toEqual([false, false]);
    step = queue.pauseAllWithFade();
    await advance(1000);
    await step;
    step = queue.resumeAllWithFade();
    await advance(1000);
    await step;
    expect(queue.getAllChannelsPauseState()).toEqual([false, false]);
  });

  test('fades finish even when timers are throttled to once per second', async () => {
    const queue = await playing();
    const pause = queue.pauseWithFade(FadeType.Linear, 0, 300);
    jest.advanceTimersByTime(1000);
    await flush();
    await pause;
    expect(queue.isChannelPaused()).toBe(true);
  });
});

describe('volume', () => {
  test('setChannelVolume applies instantly and clamps', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    await queue.setChannelVolume(0, 0.25);
    expect(audioAt(0).volume).toBe(0.25);
    await queue.setChannelVolume(0, 5);
    expect(queue.getChannelVolume()).toBe(1);
    await queue.setChannelVolume(0, NaN);
    expect(queue.getChannelVolume()).toBe(1);
  });

  test('transitions work on idle channels and apply to the next item', async () => {
    const queue = setup();
    const done = queue.setChannelVolume(0, 0.3, 200, EasingType.Linear);
    await advance(300);
    await done;
    expect(queue.getChannelVolume()).toBeCloseTo(0.3);
    await queue.queueAudio('/a.mp3');
    expect(audioAt(0).volume).toBeCloseTo(0.3);
  });

  test('transitionVolume animates, cancelVolumeTransition stops midway', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    const done = queue.transitionVolume(0, 0, 400, EasingType.Linear);
    await advance(200);
    queue.cancelVolumeTransition(0);
    await done;
    const volume = queue.getChannelVolume();
    expect(volume).toBeGreaterThan(0.3);
    expect(volume).toBeLessThan(0.7);
    await advance(400);
    expect(queue.getChannelVolume()).toBe(volume);
    queue.cancelVolumeTransition(9);
  });

  test('a new transition replaces a running one', async () => {
    const queue = setup();
    const first = queue.transitionVolume(0, 0, 400);
    await advance(100);
    const second = queue.transitionVolume(0, 1, 100);
    await advance(500);
    await Promise.all([first, second]);
    expect(queue.getChannelVolume()).toBe(1);
  });

  test('cancelAllVolumeTransitions stops every channel', async () => {
    const queue = setup();
    const a = queue.transitionVolume(0, 0, 400);
    const b = queue.transitionVolume(1, 0, 400);
    await advance(100);
    queue.cancelAllVolumeTransitions();
    await Promise.all([a, b]);
    expect(queue.getChannelVolume(0)).toBeGreaterThan(0);
    expect(queue.getChannelVolume(1)).toBeGreaterThan(0);
  });

  test('getAllChannelsVolume and setAllChannelsVolume', async () => {
    const queue = setup();
    await queue.setChannelVolume(2, 0.5);
    expect(queue.getAllChannelsVolume()).toEqual([1, 1, 0.5]);
    await queue.setAllChannelsVolume(0.2);
    expect(queue.getAllChannelsVolume()).toEqual([1, 1, 0.2]);
    expect(setup().getAllChannelsVolume()).toEqual([]);
  });

  test('global volume multiplies every channel, including per-item volumes', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3', 0, { volume: 0.4 });
    await queue.setGlobalVolume(0.5);
    expect(queue.getGlobalVolume()).toBe(0.5);
    expect(audioAt(0).volume).toBeCloseTo(0.2);
    await queue.queueAudio('/b.mp3', 1);
    expect(audioAt(1).volume).toBeCloseTo(0.5);
    await queue.setGlobalVolume(-3);
    expect(queue.getGlobalVolume()).toBe(0);
  });
});

describe('volume ducking', () => {
  const duck = (queue: AudioQueue): void =>
    queue.setVolumeDucking({
      duckTransitionDuration: 100,
      duckingVolume: 0.2,
      priorityChannel: 1,
      priorityVolume: 0.9,
      restoreTransitionDuration: 100
    });

  test('ducks other channels while the priority channel has audio, then restores', async () => {
    const queue = setup();
    duck(queue);
    await queue.queueAudio('/music.mp3', 0);
    await flush();
    await queue.queueAudio('/voice.mp3', 1);
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
    await queue.queueAudio('/voice.mp3', 1);
    await advance(200);
    await queue.queueAudio('/sfx.mp3', 2);
    expect(audioAt(1).volume).toBeCloseTo(0.2);
  });

  test('ducking never delays the priority sound', async () => {
    const queue = setup();
    duck(queue);
    await queue.queueAudio('/music.mp3', 0);
    await queue.queueAudio('/voice.mp3', 1);
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('clearVolumeDucking restores everything', async () => {
    const queue = setup();
    duck(queue);
    await queue.queueAudio('/music.mp3', 0);
    await queue.queueAudio('/voice.mp3', 1);
    await advance(200);
    queue.clearVolumeDucking();
    await advance(300);
    expect(audioAt(0).volume).toBeCloseTo(1);
  });

  test('uses default transition settings when none are given', async () => {
    const queue = setup();
    queue.setVolumeDucking({ duckingVolume: 0.5, priorityChannel: 1, priorityVolume: 1 });
    await queue.queueAudio('/music.mp3', 0);
    await queue.queueAudio('/voice.mp3', 1);
    await advance(100);
    expect(audioAt(0).volume).toBeGreaterThan(0.5);
    await advance(300);
    expect(audioAt(0).volume).toBeCloseTo(0.5);
  });

  test('rejects an invalid priority channel', () => {
    expect(() =>
      setup().setVolumeDucking({ duckingVolume: 0.2, priorityChannel: 99, priorityVolume: 1 })
    ).toThrow(RangeError);
  });

  test('destroying the priority channel restores the others', async () => {
    const queue = setup();
    duck(queue);
    await queue.queueAudio('/music.mp3', 0);
    await queue.queueAudio('/voice.mp3', 1);
    await advance(200);
    await queue.destroyChannel(1);
    await advance(200);
    expect(audioAt(0).volume).toBeCloseTo(1);
  });
});

describe('Web Audio routing', () => {
  beforeEach(() => installFakeAudioContext());

  describe('stereo panning', () => {
    const context = (): FakeAudioContext => FakeAudioContext.instances[0] as FakeAudioContext;

    test('a panned channel routes through Web Audio on desktop, with the gain node in control', async () => {
      const queue = setup({ webAudio: 'auto' });
      queue.setChannelPan(0, -0.5);
      await queue.queueAudio('/a.mp3');
      expect(context().panners[0]?.pan.value).toBe(-0.5);
      expect(audioAt(0).volume).toBe(1);
      await queue.setChannelVolume(0, 0.4);
      expect(context().gains[0]?.gain.value).toBeCloseTo(0.4);
      expect(audioAt(0).volume).toBe(1);
    });

    test('panning a playing item routes it then, keeping its volume', async () => {
      const queue = setup({ webAudio: 'auto' });
      await queue.setChannelVolume(0, 0.3);
      await queue.queueAudio('/a.mp3');
      await flush();
      expect(FakeAudioContext.instances).toHaveLength(0);
      queue.setChannelPan(0, 1);
      expect(context().sources).toHaveLength(1);
      expect(context().panners[0]?.pan.value).toBe(1);
      expect(context().gains[0]?.gain.value).toBeCloseTo(0.3);
      expect(audioAt(0).volume).toBe(1);
      queue.setChannelPan(0, 0.25);
      expect(context().sources).toHaveLength(1);
      expect(context().panners[0]?.pan.value).toBe(0.25);
    });

    test('back to center keeps the route; unpanned channels stay unrouted', async () => {
      const queue = setup({ webAudio: 'auto' });
      queue.setChannelPan(0, 0.5);
      await queue.queueAudio('/a.mp3', 0);
      await queue.queueAudio('/b.mp3', 1);
      queue.setChannelPan(0, 0);
      expect(context().sources).toHaveLength(1);
      expect(context().panners[0]?.pan.value).toBe(0);
    });

    test('cross-origin audio without CORS plays centered, with a warning', async () => {
      const warn = jest.fn();
      const queue = setup({ logger: { error: jest.fn(), warn }, webAudio: 'auto' });
      queue.setChannelPan(0, -1);
      await queue.queueAudio('https://cdn.other.com/a.mp3');
      expect(FakeAudioContext.instances[0]?.sources ?? []).toHaveLength(0);
      expect(String(callArg(warn))).toMatch(/cannot pan a\.mp3: cross-origin without CORS/);
      await queue.queueAudio('https://cdn.other.com/b.mp3', 1, { crossOrigin: 'anonymous' });
      queue.setChannelPan(1, 1);
      expect(context().panners[0]?.pan.value).toBe(1);
    });

    test("webAudio 'off' never routes", async () => {
      const queue = setup({ webAudio: 'off' });
      queue.setChannelPan(0, 1);
      await queue.queueAudio('/a.mp3');
      expect(FakeAudioContext.instances).toHaveLength(0);
      expect(queue.getChannelPan(0)).toBe(1);
    });

    test('browsers without StereoPannerNode still route volume and do not throw', async () => {
      FakeAudioContext.hasStereoPanner = false;
      const queue = setup({ webAudio: 'force' });
      queue.setChannelPan(0, 1);
      await queue.queueAudio('/a.mp3');
      expect(context().sources).toHaveLength(1);
      expect(context().panners).toHaveLength(0);
      expect(() => queue.setChannelPan(0, -1)).not.toThrow();
    });

    test('released items disconnect their panner', async () => {
      const queue = setup({ webAudio: 'auto' });
      queue.setChannelPan(0, 1);
      await queue.queueAudio('/a.mp3');
      await queue.stopAllAudioInChannel(0);
      expect(context().panners[0]?.disconnect).toHaveBeenCalled();
    });

    test('positions are clamped; non-numbers and bad channels are rejected', () => {
      const queue = setup();
      expect(queue.getChannelPan()).toBe(0);
      expect(queue.getChannelPan(9)).toBe(0);
      queue.setChannelPan(0, 3);
      expect(queue.getChannelPan(0)).toBe(1);
      queue.setChannelPan(0, -3);
      expect(queue.getChannelPan(0)).toBe(-1);
      expect(() => queue.setChannelPan(0, Number.NaN)).toThrow(RangeError);
      expect(() => queue.setChannelPan(-1, 0)).toThrow(RangeError);
    });
  });

  test('force mode routes through one shared context and controls gain, not element volume', async () => {
    const queue = setup({ webAudio: 'force' });
    await queue.queueAudio('/a.mp3', 0);
    await queue.queueAudio('/b.mp3', 1);
    await queue.setChannelVolume(0, 0.3);
    expect(FakeAudioContext.instances).toHaveLength(1);
    const context = FakeAudioContext.instances[0] as FakeAudioContext;
    expect(context.gains[0]?.gain.value).toBeCloseTo(0.3);
    expect(audioAt(0).volume).toBe(1);
  });

  test('auto mode on iOS routes same-origin audio but not cross-origin audio', async () => {
    setUserAgent(IPHONE_UA);
    const queue = setup({ webAudio: 'auto' });
    await queue.queueAudio('/same-origin.mp3', 0);
    await queue.queueAudio('https://cdn.other.com/x.mp3', 1);
    await queue.queueAudio('https://cors.other.com/y.mp3', 2, { crossOrigin: 'anonymous' });
    const context = FakeAudioContext.instances[0] as FakeAudioContext;
    expect(context.sources).toHaveLength(2);
  });

  test('auto mode on desktop does not use Web Audio', async () => {
    const queue = setup({ webAudio: 'auto' });
    await queue.queueAudio('/a.mp3');
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  test('released items disconnect their nodes', async () => {
    const queue = setup({ webAudio: 'force' });
    await queue.queueAudio('/a.mp3');
    await queue.stopAllAudioInChannel();
    const context = FakeAudioContext.instances[0] as FakeAudioContext;
    expect(context.sources[0]?.disconnect).toHaveBeenCalled();
  });

  test('falls back to element volume when routing fails', async () => {
    FakeAudioContext.failSourceCreation = true;
    const queue = setup({ webAudio: 'force' });
    await queue.queueAudio('/a.mp3');
    await queue.setChannelVolume(0, 0.4);
    expect(audioAt(0).volume).toBe(0.4);
  });

  test('unlockAudio resumes the shared context', async () => {
    const queue = setup({ webAudio: 'force' });
    await queue.queueAudio('/a.mp3');
    const context = FakeAudioContext.instances[0] as FakeAudioContext;
    context.state = 'suspended';
    queue.unlockAudio();
    expect(context.resume).toHaveBeenCalledTimes(2);
  });
});

describe('information', () => {
  test('getCurrentAudioInfo describes the current item', async () => {
    const queue = setup();
    expect(queue.getCurrentAudioInfo()).toBeNull();
    await queue.queueAudio('/a.mp3', 0, { loop: true });
    await queue.queueAudio('/b.mp3');
    await flush();
    audioAt(0).currentTime = 2.5;
    expect(queue.getCurrentAudioInfo()).toEqual({
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
    await queue.queueAudio('/a.mp3', 1);
    const info = queue.getAllChannelsInfo();
    expect(info).toHaveLength(2);
    expect(info[0]).toBeNull();
    expect(info[1]?.fileName).toBe('a.mp3');
  });

  test('getQueueSnapshot returns null for unused channels and -1 index when empty', async () => {
    const queue = setup();
    expect(queue.getQueueSnapshot(4)).toBeNull();
    await queue.setChannelVolume(4, 0.5);
    expect(queue.getQueueSnapshot(4)).toEqual({
      channelNumber: 4,
      currentIndex: -1,
      isPaused: false,
      items: [],
      totalItems: 0,
      volume: 0.5
    });
  });
});
