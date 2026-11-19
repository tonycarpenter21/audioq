/**
 * @fileoverview Tests that kill mutations which survived the original suite (ids from the
 * adversarial review's mutation run are in the test names).
 */
import { AudioQueue, createAudioQueue } from '../../src/audio-queue';
import { mergeQueueConfig, defaultQueueConfig } from '../../src/config';
import type { QueueConfig } from '../../src/types';
import { FadeType } from '../../src/types';
import {
  DESKTOP_UA,
  FakeAudio,
  advance,
  audioAt,
  flush,
  installFakeAudio,
  removeAudioContext,
  setUserAgent
} from '../helpers/fake-audio';
import { isIOSDevice } from '../../src/web-audio';

const setup = (config: Partial<QueueConfig> = {}): AudioQueue =>
  createAudioQueue({ logger: null, ...config });

beforeEach(() => {
  jest.useFakeTimers();
  installFakeAudio();
  removeAudioContext();
  setUserAgent(DESKTOP_UA);
});
afterEach(() => jest.useRealTimers());

test('M49 clearQueueAfterCurrent settles handles and releases elements of removed items', async () => {
  const q = setup();
  await q.queueAudio('/a.mp3');
  const b = await q.queueAudio('/b.mp3');
  await q.clearQueueAfterCurrent();
  await expect(b.finished).resolves.toBe('removed');
  await expect(b.started).resolves.toBe(false);
  expect(audioAt(1).src).toBe('');
});

test('M02 stopAllAudioInChannel after a completed pauseWithFade: next item is audible', async () => {
  const q = setup();
  await q.queueAudio('/a.mp3');
  await flush();
  const fade = q.pauseWithFade(FadeType.Linear, 0, 100);
  await advance(200);
  await fade;
  await q.stopAllAudioInChannel(0);
  await q.queueAudio('/b.mp3');
  expect(audioAt(1).volume).toBe(1);
});

test('M03 stopAllAudioInChannel on the priority channel restores ducked channels', async () => {
  const q = setup();
  q.setVolumeDucking({ duckingVolume: 0.2, priorityChannel: 1, priorityVolume: 1 });
  await q.queueAudio('/music.mp3', 0);
  await q.queueAudio('/voice.mp3', 1);
  await advance(300);
  await q.stopAllAudioInChannel(1);
  await advance(300);
  expect(audioAt(0).volume).toBeCloseTo(1);
});

test('M21 duck and restore use their own durations', async () => {
  const q = setup();
  q.setVolumeDucking({
    duckTransitionDuration: 0,
    duckingVolume: 0.2,
    priorityChannel: 1,
    priorityVolume: 1,
    restoreTransitionDuration: 1000
  });
  await q.queueAudio('/music.mp3', 0);
  await q.queueAudio('/voice.mp3', 1);
  expect(audioAt(0).volume).toBeCloseTo(0.2); // instant duck
  audioAt(1).finish();
  await advance(300);
  expect(audioAt(0).volume).toBeLessThan(0.9); // slow restore
});

test('M04 destroyChannel stops a running volume transition (no orphan timers)', async () => {
  const q = setup();
  void q.setChannelVolume(3, 0, 10000);
  await advance(32);
  await q.destroyChannel(3);
  expect(jest.getTimerCount()).toBe(0);
});

test('M11 a successful unlock removes the document gesture listeners', async () => {
  FakeAudio.defaultPlayBehavior = 'not-allowed';
  const q = setup();
  await q.queueAudio('/a.mp3');
  await flush();
  const remove = jest.spyOn(document, 'removeEventListener');
  FakeAudio.defaultPlayBehavior = 'resolve';
  audioAt(0).playBehavior = 'resolve';
  q.unlockAudio();
  await flush(); // listeners are removed once playback really starts
  expect(remove).toHaveBeenCalledWith('mousedown', expect.any(Function), { capture: true });
});

test('M14 a NotSupported rejection that arrives after pause does not skip the item', async () => {
  let reject: (e: Error) => void = () => undefined;
  jest
    .spyOn(FakeAudio.prototype, 'play')
    .mockImplementation(() => new Promise<void>((_resolve, rej) => (reject = rej)));
  const q = setup();
  const a = await q.queueAudio('/a.mp3');
  await q.pauseChannel();
  const err = new Error('x');
  err.name = 'NotSupportedError';
  reject(err);
  await flush();
  expect(q.getQueueLength()).toBe(1);
  await expect(Promise.race([a.finished, flush().then(() => 'pending')])).resolves.toBe('pending');
});

test('M26 isPlaying stays false while play() resolved but the "playing" event has not fired', async () => {
  FakeAudio.defaultPlayBehavior = 'resolve-silently';
  const q = setup();
  await q.queueAudio('/a.mp3');
  await flush();
  expect(q.getCurrentAudioInfo()?.isPlaying).toBe(false);
});

test('M24 progress is capped at 1 when currentTime overshoots duration (VBR files)', async () => {
  const q = setup();
  await q.queueAudio('/a.mp3');
  await flush();
  audioAt(0).currentTime = 12; // duration 10
  expect(q.getCurrentAudioInfo()?.progress).toBe(1);
});

test('M15/N10 a second NotAllowed rejection does not emit a second error', async () => {
  FakeAudio.defaultPlayBehavior = 'not-allowed';
  const q = setup();
  const errors = jest.fn();
  q.onAudioError(0, errors);
  await q.queueAudio('/a.mp3');
  await flush();
  await q.pauseChannel();
  await q.resumeChannel();
  await flush();
  expect(errors).toHaveBeenCalledTimes(1);
});

test('N05 prefetchCount must be an integer', () => {
  expect(() => mergeQueueConfig(defaultQueueConfig(), { prefetchCount: 1.5 })).toThrow(RangeError);
});

test('N17 setGlobalVolume(NaN) keeps the current global volume', async () => {
  const q = setup();
  await q.setGlobalVolume(0.3);
  await q.setGlobalVolume(NaN);
  expect(q.getGlobalVolume()).toBe(0.3);
});

test('N03 a touch-capable Mac with maxTouchPoints 1 is not an iPad', () => {
  setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 1);
  expect(isIOSDevice()).toBe(false);
});

test('M20 queueing more priority audio mid-duck does not restart the duck transition', async () => {
  const q = setup();
  q.setVolumeDucking({
    duckTransitionDuration: 400,
    duckingVolume: 0.2,
    priorityChannel: 1,
    priorityVolume: 1
  });
  await q.queueAudio('/music.mp3', 0);
  await q.queueAudio('/voice-1.mp3', 1);
  await advance(200);
  const midway = audioAt(0).volume;
  await q.queueAudio('/voice-2.mp3', 1);
  await advance(16);
  expect(audioAt(0).volume).toBeLessThanOrEqual(midway);
  await advance(300);
  expect(audioAt(0).volume).toBeCloseTo(0.2);
});

test('M30 the complete event fires before the handle settles', async () => {
  const q = setup();
  const order: string[] = [];
  q.onAudioComplete(0, () => order.push('complete'));
  const item = await q.queueAudio('/a.mp3');
  void item.finished.then(() => order.push('finished'));
  await flush();
  audioAt(0).finish();
  await flush();
  expect(order).toEqual(['complete', 'finished']);
});

test('M38 a no-op reorder does not emit a queue change', async () => {
  const q = setup();
  await q.queueAudio('/a.mp3');
  await q.queueAudio('/b.mp3');
  const changes = jest.fn();
  q.onQueueChange(0, changes);
  expect((await q.reorderQueue(1, 1)).success).toBe(true);
  expect((await q.swapQueueItems(1, 1)).success).toBe(true);
  expect(changes).not.toHaveBeenCalled();
});
