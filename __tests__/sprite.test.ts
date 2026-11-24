import {
  createAudioQueue,
  destroyAllChannels,
  getQueueItemInfo,
  getQueueLength,
  setQueueConfig
} from '../src/queue';
import type { AudioQueue } from '../src/queue';
import { getDefaultAudioQueue } from '../src/default-queue';
import { defineSprite } from '../src/sprite';
import { FakeAudio, advance, audioAt, flush, installFakeAudio } from './helpers/fake-audio';

let queue: AudioQueue;

beforeEach(() => {
  jest.useFakeTimers();
  installFakeAudio();
  FakeAudio.mediaClock = true;
  queue = createAudioQueue({ logger: null });
});

afterEach(() => jest.useRealTimers());

describe('defineSprite', () => {
  test('plays a named segment of one file', async () => {
    const sfx = defineSprite('/sfx/sprite.mp3', { coin: [500, 800], jump: [0, 400] }, queue);
    expect(sfx.names).toEqual(['coin', 'jump']);
    const item = await sfx.play('coin');
    await flush();
    expect(audioAt(0).src).toBe('http://localhost/sfx/sprite.mp3');
    expect(audioAt(0).currentTime).toBe(0.5);
    await advance(320, 10);
    await expect(item.finished).resolves.toBe('ended');
  });

  test('passes channel and options through; segment loop and option loop', async () => {
    const sfx = defineSprite(
      '/sfx/sprite.mp3',
      { engine: { endMs: 2000, loop: true, startMs: 1000 }, hit: [0, 100] },
      queue
    );
    await sfx.play('engine', 3, { volume: 0.5 });
    expect(getQueueItemInfo(queue, 0, 3)).toMatchObject({ isLooping: true, volume: 0.5 });
    await sfx.play('hit', 4, { loop: true });
    expect(getQueueItemInfo(queue, 0, 4)?.isLooping).toBe(true);
    await sfx.play('engine', 5, { loop: false });
    expect(getQueueItemInfo(queue, 0, 5)?.isLooping).toBe(false);
  });

  test('interrupt lets rapid sounds cut each other off', async () => {
    const sfx = defineSprite('/sfx/sprite.mp3', { coin: [0, 300] }, queue);
    await sfx.play('coin', 0, { interrupt: true });
    await sfx.play('coin', 0, { interrupt: true });
    expect(getQueueLength(queue)).toBe(1);
  });

  test('rejects unknown names', async () => {
    const sfx = defineSprite('/sfx/sprite.mp3', { coin: [0, 300] }, queue);
    await expect(sfx.play('nope' as 'coin')).rejects.toThrow(/Unknown sprite "nope"/);
  });

  test.each([
    [{ bad: [300, 300] as const }],
    [{ bad: [-1, 100] as const }],
    [{ bad: { endMs: NaN, startMs: 0 } }]
  ])('rejects invalid segments %p', (map) => {
    expect(() => defineSprite('/s.mp3', map, queue)).toThrow(RangeError);
  });

  test('uses the default queue when none is given', async () => {
    setQueueConfig(getDefaultAudioQueue(), { logger: null });
    const sfx = defineSprite('/sfx/sprite.mp3', { coin: [0, 300] });
    await sfx.play('coin', 6);
    expect(getQueueLength(getDefaultAudioQueue(), 6)).toBe(1);
    await destroyAllChannels(getDefaultAudioQueue());
  });
});
