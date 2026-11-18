import { Channel } from '../src/channel';
import type { Item } from '../src/channel';
import type { Tween } from '../src/tween';
import { FakeAudio } from './helpers/fake-audio';

const item = (overrides: Partial<Item> = {}): Item => ({
  blocked: false,
  channelNumber: 0,
  crossOrigin: undefined,
  disposers: [],
  element: undefined,
  id: 1,
  loadTimer: undefined,
  loop: false,
  playRequested: false,
  resolveFinished: jest.fn(),
  resolveStarted: jest.fn(),
  route: undefined,
  settled: false,
  src: 'http://localhost/a%20b.mp3',
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
