import { Channel } from '../src/channel';
import type { Item } from '../src/channel';
import type { Tween } from '../src/tween';
import { FakeAudio } from './helpers/fake-audio';

const item = (overrides: Partial<Item> = {}): Item => ({
  activeCues: new Set(),
  blocked: false,
  channelNumber: 0,
  crossOrigin: undefined,
  cues: [],
  disposers: [],
  endAt: undefined,
  element: undefined,
  fileName: 'a b.mp3',
  id: 1,
  lastCueMs: -1,
  loadTimer: undefined,
  loop: false,
  metadata: undefined,
  objectUrl: undefined,
  playbackRate: 1,
  playRequested: false,
  positionTimer: undefined,
  resolveFinished: jest.fn(),
  resolveStarted: jest.fn(),
  route: undefined,
  segmentStart: 0,
  settled: false,
  src: 'http://localhost/a%20b.mp3',
  startAt: 0,
  started: false,
  volume: 1,
  ...overrides
});

const fakeTween = (): Tween & { cancel: jest.Mock } => ({
  cancel: jest.fn(),
  done: Promise.resolve(true)
});

describe('Channel', () => {
  test('starts empty with neutral factors', () => {
    const channel = new Channel(3);
    expect(channel.channelNumber).toBe(3);
    expect(channel.head).toBeUndefined();
    expect(channel.effectiveGain(1)).toBe(1);
    expect(channel.paused).toBe(false);
  });

  test('head is the first item', () => {
    const channel = new Channel(0);
    const first = item({ id: 1 });
    channel.items.push(first, item({ id: 2 }));
    expect(channel.head).toBe(first);
  });

  test('effectiveGain multiplies channel, item, global, duck and fade factors', () => {
    const channel = new Channel(0);
    channel.items.push(item({ volume: 0.5 }));
    channel.volume = 0.8;
    channel.duckFactor = 0.5;
    channel.fadeFactor = 0.5;
    expect(channel.effectiveGain(0.5)).toBeCloseTo(0.8 * 0.5 * 0.5 * 0.5 * 0.5);
  });

  test('effectiveGain is clamped to 0-1', () => {
    const channel = new Channel(0);
    channel.volume = 3;
    expect(channel.effectiveGain(1)).toBe(1);
    channel.volume = -1;
    expect(channel.effectiveGain(1)).toBe(0);
  });

  test('cancelTweens cancels and forgets every transition', () => {
    const channel = new Channel(0);
    const tweens = [fakeTween(), fakeTween(), fakeTween()];
    [channel.volumeTween, channel.duckTween, channel.fadeTween] = tweens;
    channel.cancelTweens();
    tweens.forEach((tween) => expect(tween.cancel).toHaveBeenCalled());
    expect(channel.volumeTween).toBeUndefined();
    expect(channel.duckTween).toBeUndefined();
    expect(channel.fadeTween).toBeUndefined();
    expect(() => channel.cancelTweens()).not.toThrow();
  });

  test('describeItems reports plain-text names, durations and playing state', () => {
    const channel = new Channel(0);
    const element = new FakeAudio('/a.mp3');
    element.duration = 2;
    element.paused = false;
    channel.items.push(item({ element: element as unknown as HTMLAudioElement, id: 7 }));
    channel.items.push(item({ id: 8, loop: true, volume: 0.3 }));
    const [first, second] = channel.describeItems();
    expect(first).toMatchObject({
      duration: 2000,
      fileName: 'a b.mp3',
      id: 7,
      isCurrentlyPlaying: true
    });
    expect(second).toMatchObject({
      duration: 0,
      id: 8,
      isCurrentlyPlaying: false,
      isLooping: true,
      volume: 0.3
    });
    channel.paused = true;
    expect(channel.describeItems()[0]?.isCurrentlyPlaying).toBe(false);
  });
});

describe('Channel feature helpers', () => {
  test('effectiveRate multiplies the item and channel rates', () => {
    const channel = new Channel(0);
    expect(channel.effectiveRate()).toBe(1);
    channel.items.push(item({ playbackRate: 0.5 }));
    channel.playbackRate = 3;
    expect(channel.effectiveRate()).toBe(1.5);
  });

  test('clearGap cancels a pending gap timer and is idempotent', () => {
    jest.useFakeTimers();
    try {
      const channel = new Channel(0);
      const fired = jest.fn();
      channel.gapTimer = setTimeout(fired, 100) as unknown as Channel['gapTimer'];
      channel.clearGap();
      channel.clearGap();
      jest.advanceTimersByTime(200);
      expect(fired).not.toHaveBeenCalled();
      expect(channel.gapTimer).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test('remember keeps the newest entries up to the limit; 0 keeps none', () => {
    const channel = new Channel(0);
    const entry = (id: number) => ({
      channelNumber: 0,
      fileName: `${id}.mp3`,
      finishedAt: id,
      id,
      metadata: undefined,
      playedMs: 0,
      reason: 'ended' as const,
      src: `/${id}.mp3`
    });
    [1, 2, 3].forEach((id) => channel.remember(entry(id), 2));
    expect(channel.history.map((e) => e.id)).toEqual([2, 3]);
    channel.remember(entry(4), 0);
    expect(channel.history.map((e) => e.id)).toEqual([2, 3]);
  });

  test('isDuplicate tracks a window per source and forgets expired entries', () => {
    const channel = new Channel(0);
    expect(channel.isDuplicate('/a.mp3', 1000, 0)).toBe(false);
    expect(channel.isDuplicate('/a.mp3', 1000, 999)).toBe(true);
    expect(channel.isDuplicate('/b.mp3', 1000, 999)).toBe(false);
    expect(channel.isDuplicate('/a.mp3', 1000, 1000)).toBe(false);
    expect(channel.recentSources.size).toBe(2);
  });
});
