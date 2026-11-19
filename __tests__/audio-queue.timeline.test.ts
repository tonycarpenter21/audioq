/**
 * @fileoverview Features driven by the playback position: segments (endAt), segment loops, cues
 * and crossfades. FakeAudio's media clock advances currentTime with fake time while playing.
 */
import { createAudioQueue } from '../src/audio-queue';
import type { AudioQueue } from '../src/audio-queue';
import type { AudioCueInfo, QueueConfig } from '../src/types';
import {
  DESKTOP_UA,
  FakeAudio,
  advance,
  audioAt,
  flush,
  installFakeAudio,
  removeAudioContext,
  setUserAgent
} from './helpers/fake-audio';

const setup = (config: Partial<QueueConfig> = {}): AudioQueue =>
  createAudioQueue({ logger: null, ...config });

const names = (queue: AudioQueue, channel = 0): string[] =>
  queue.getQueueSnapshot(channel)?.items.map((item) => item.fileName) ?? [];

beforeEach(() => {
  jest.useFakeTimers();
  installFakeAudio();
  FakeAudio.mediaClock = true;
  removeAudioContext();
  setUserAgent(DESKTOP_UA);
});

afterEach(() => jest.useRealTimers());

describe('segments (endAt)', () => {
  test('playback stops at endAt with timer precision and the next item plays', async () => {
    const queue = setup();
    const complete = jest.fn();
    queue.onAudioComplete(0, complete);
    const item = await queue.queueAudio('/sprite.mp3', 0, { endAt: 1300, startAt: 1000 });
    await queue.queueAudio('/next.mp3');
    await flush();
    expect(audioAt(0).currentTime).toBe(1);
    await advance(280, 10);
    expect(complete).not.toHaveBeenCalled();
    await advance(30, 10);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ fileName: 'sprite.mp3', reason: 'ended' });
    await expect(item.finished).resolves.toBe('ended');
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('endAt respects the playback rate', async () => {
    const queue = setup();
    const complete = jest.fn();
    queue.onAudioComplete(0, complete);
    await queue.queueAudio('/a.mp3', 0, { endAt: 400, playbackRate: 2 });
    await flush();
    await advance(190, 10);
    expect(complete).not.toHaveBeenCalled();
    await advance(20, 10);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('pausing freezes the segment; resuming finishes it', async () => {
    const queue = setup();
    const complete = jest.fn();
    queue.onAudioComplete(0, complete);
    await queue.queueAudio('/a.mp3', 0, { endAt: 300 });
    await flush();
    await advance(100, 10);
    await queue.pauseChannel();
    await advance(2000, 100);
    expect(complete).not.toHaveBeenCalled();
    await queue.resumeChannel();
    audioAt(0).startPlaying();
    await advance(220, 10);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('a looping segment jumps back to its start instead of ending', async () => {
    const queue = setup();
    const complete = jest.fn();
    queue.onAudioComplete(0, complete);
    await queue.queueAudio('/loop.mp3', 0, { endAt: 1500, loop: true, startAt: 1000 });
    await flush();
    expect(audioAt(0).loop).toBe(false);
    await advance(520, 10);
    expect(complete).not.toHaveBeenCalled();
    expect(audioAt(0).currentTime).toBeGreaterThanOrEqual(1);
    expect(audioAt(0).currentTime).toBeLessThan(1.1);
  });

  test('repeat "one" replays the segment from its start', async () => {
    const queue = setup();
    queue.setRepeatMode(0, 'one');
    await queue.queueAudio('/a.mp3', 0, { endAt: 2300, startAt: 2000 });
    await flush();
    await advance(320, 10);
    expect(audioAt(0).playCalls).toBe(2);
    expect(audioAt(0).currentTime).toBeCloseTo(2, 1);
  });

  test('repeat "all" keeps the segment on the copy', async () => {
    const queue = setup();
    queue.setRepeatMode(0, 'all');
    await queue.queueAudio('/a.mp3', 0, { endAt: 500, startAt: 200 });
    await queue.queueAudio('/b.mp3');
    await flush();
    await advance(320, 10);
    expect(names(queue)).toEqual(['b.mp3', 'a.mp3']);
    audioAt(1).finish();
    await flush();
    const copies = FakeAudio.instances.filter((audio) => audio.src.endsWith('/a.mp3'));
    expect(copies).toHaveLength(1);
    expect(copies[0]?.currentTime).toBeCloseTo(0.2, 1);
  });

  test('items without endAt still end normally', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    await flush();
    await advance(500, 50);
    expect(queue.getQueueLength()).toBe(1);
  });

  test.each([
    [{ endAt: 100, startAt: 100 }],
    [{ endAt: 50, startAt: 100 }],
    [{ endAt: NaN }],
    [{ endAt: Infinity }]
  ])('rejects an invalid segment %p', async (options) => {
    await expect(setup().queueAudio('/a.mp3', 0, options)).rejects.toThrow(RangeError);
  });
});

describe('cues', () => {
  const collect = (queue: AudioQueue): AudioCueInfo[] => {
    const seen: AudioCueInfo[] = [];
    queue.onAudioCue(0, (info) => seen.push(info));
    return seen;
  };

  test('ranged cues fire on enter and exit, point cues once, all at the right time', async () => {
    const queue = setup();
    const seen = collect(queue);
    await queue.queueAudio('/talk.mp3', 0, {
      cues: [
        { endMs: 2000, startMs: 1000, text: 'Hello' },
        { data: { animation: 'wave' }, startMs: 1500 }
      ],
      metadata: { title: 'Talk' }
    });
    await flush();
    await advance(990, 10);
    expect(seen).toEqual([]);
    await advance(20, 10);
    expect(seen.map((s) => [s.cue.text, s.active])).toEqual([['Hello', true]]);
    expect(seen[0]).toMatchObject({ channelNumber: 0, fileName: 'talk.mp3', index: 0 });
    expect(seen[0]?.metadata).toEqual({ title: 'Talk' });
    await advance(500, 10);
    expect(seen[1]).toMatchObject({ active: true, index: 1 });
    expect(seen[1]?.cue.data).toEqual({ animation: 'wave' });
    await advance(500, 10);
    expect(seen.map((s) => [s.index, s.active])).toEqual([
      [0, true],
      [1, true],
      [0, false]
    ]);
  });

  test('cues are sorted by start time and keep your objects', async () => {
    const queue = setup();
    const seen = collect(queue);
    const late = { startMs: 300, text: 'late' };
    const early = { startMs: 100, text: 'early' };
    await queue.queueAudio('/a.mp3', 0, { cues: [late, early] });
    await flush();
    await advance(400, 10);
    expect(seen.map((s) => s.cue)).toEqual([early, late]);
    expect(seen[1]?.cue).toBe(late);
  });

  test('a cue at 0 fires as playback starts', async () => {
    const queue = setup();
    const seen = collect(queue);
    await queue.queueAudio('/a.mp3', 0, { cues: [{ startMs: 0, text: 'start' }] });
    await flush();
    expect(seen).toHaveLength(1);
  });

  test('seeking back replays point cues; seeking into a range enters it', async () => {
    const queue = setup();
    const seen = collect(queue);
    await queue.queueAudio('/a.mp3', 0, {
      cues: [{ startMs: 200 }, { endMs: 5000, startMs: 4000 }]
    });
    await flush();
    await advance(300, 10);
    expect(seen).toHaveLength(1);
    queue.seekTo(0, 0);
    await advance(300, 10);
    expect(seen).toHaveLength(2);
    queue.seekTo(0, 4500);
    expect(seen[2]).toMatchObject({ active: true, index: 1 });
    queue.seekTo(0, 6000);
    expect(seen[3]).toMatchObject({ active: false, index: 1 });
  });

  test('active cues are exited when the item stops', async () => {
    const queue = setup();
    const seen = collect(queue);
    await queue.queueAudio('/a.mp3', 0, { cues: [{ endMs: 5000, startMs: 0, text: 'x' }] });
    await flush();
    expect(seen.map((s) => s.active)).toEqual([true]);
    await queue.stopAllAudioInChannel();
    expect(seen.map((s) => s.active)).toEqual([true, false]);
  });

  test('cues update while paused when the user seeks', async () => {
    const queue = setup();
    const seen = collect(queue);
    await queue.queueAudio('/a.mp3', 0, { cues: [{ endMs: 3000, startMs: 2000 }] });
    await flush();
    await queue.pauseChannel();
    queue.seekTo(0, 2500);
    expect(seen.map((s) => s.active)).toEqual([true]);
  });

  test('offAudioCue removes listeners; subscriptions validate the channel', async () => {
    const queue = setup();
    const listener = jest.fn();
    queue.onAudioCue(0, listener);
    queue.offAudioCue(0, listener);
    const other = jest.fn();
    queue.onAudioCue(0, other);
    queue.offAudioCue();
    await queue.queueAudio('/a.mp3', 0, { cues: [{ startMs: 0 }] });
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    expect(() => queue.onAudioCue(99, jest.fn())).toThrow(RangeError);
  });

  test.each([
    [[{ startMs: -1 }]],
    [[{ startMs: NaN }]],
    [[{ endMs: 100, startMs: 100 }]],
    [[{ endMs: Infinity, startMs: 0 }]]
  ])('rejects invalid cues %p', async (cues) => {
    await expect(setup().queueAudio('/a.mp3', 0, { cues })).rejects.toThrow(RangeError);
  });
});

describe('crossfade', () => {
  test('the next item starts early and fades in while the current one fades out', async () => {
    const queue = setup();
    const complete = jest.fn();
    queue.onAudioComplete(0, complete);
    queue.setCrossfade(0, 1000);
    expect(queue.getCrossfade(0)).toBe(1000);
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
    await flush();
    const [a, b] = [audioAt(0), audioAt(1)];
    await advance(8990, 100);
    expect(b.playCalls).toBe(0);
    await advance(20, 10);
    expect(b.playCalls).toBe(1);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ fileName: 'a.mp3', reason: 'ended' });
    expect(names(queue)).toEqual(['b.mp3']);
    await advance(500, 16);
    expect(a.volume).toBeGreaterThan(0.3);
    expect(a.volume).toBeLessThan(0.7);
    expect(b.volume).toBeGreaterThan(0.3);
    expect(b.volume).toBeLessThan(0.7);
    await advance(600, 16);
    expect(a.src).toBe('');
    expect(b.volume).toBeCloseTo(1);
  });

  test('is limited to half of a short item', async () => {
    const queue = setup();
    queue.setCrossfade(0, 5000);
    await queue.queueAudio('/short.mp3', 0, { endAt: 2000 });
    await queue.queueAudio('/b.mp3');
    await flush();
    await advance(990, 10);
    expect(audioAt(1).playCalls).toBe(0);
    await advance(20, 10);
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('does not crossfade the last item, loops, or repeat-one', async () => {
    const queue = setup();
    queue.setCrossfade(0, 1000);
    await queue.queueAudio('/only.mp3');
    await flush();
    await advance(9500, 100);
    expect(queue.getQueueLength()).toBe(1);
    const looping = setup();
    looping.setCrossfade(0, 1000);
    await looping.queueAudio('/loop.mp3', 0, { loop: true });
    await looping.queueAudio('/b.mp3');
    await flush();
    await advance(9500, 100);
    expect(looping.getQueueLength()).toBe(2);
    const one = setup();
    one.setCrossfade(0, 1000);
    one.setRepeatMode(0, 'one');
    await one.queueAudio('/a.mp3');
    await one.queueAudio('/b.mp3');
    await flush();
    await advance(9500, 100);
    expect(one.getQueueLength()).toBe(2);
  });

  test('with repeat "all" a single item crossfades into its own copy', async () => {
    const queue = setup();
    queue.setCrossfade(0, 1000);
    queue.setRepeatMode(0, 'all');
    await queue.queueAudio('/a.mp3');
    await flush();
    await advance(9100, 100);
    expect(FakeAudio.instances).toHaveLength(2);
    expect(names(queue)).toEqual(['a.mp3']);
  });

  test('pausing during a crossfade cuts the outgoing item', async () => {
    const queue = setup();
    queue.setCrossfade(0, 1000);
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
    await flush();
    await advance(9200, 100);
    await queue.pauseChannel();
    expect(audioAt(0).src).toBe('');
    expect(queue.isChannelPaused()).toBe(true);
  });

  test('stopping during a crossfade releases both items', async () => {
    const queue = setup();
    queue.setCrossfade(0, 1000);
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
    await flush();
    await advance(9200, 100);
    await queue.stopAllAudio();
    expect(FakeAudio.instances.every((audio) => audio.src === '')).toBe(true);
  });

  test('an error on the outgoing item just releases it', async () => {
    const queue = setup();
    const errors = jest.fn();
    queue.onAudioError(0, errors);
    queue.setCrossfade(0, 1000);
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
    await flush();
    await advance(9200, 100);
    audioAt(0).fail(2);
    expect(errors).not.toHaveBeenCalled();
    expect(audioAt(0).src).toBe('');
    expect(queue.getCurrentAudioInfo()?.fileName).toBe('b.mp3');
  });

  test('a pause still fading out is not interrupted by a crossfade', async () => {
    const queue = setup();
    queue.setCrossfade(0, 1000);
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
    await flush();
    await advance(8800, 100);
    void queue.pauseWithFade(undefined, 0, 2000);
    await advance(300, 50);
    expect(audioAt(1).playCalls).toBe(0);
  });

  test('validates the length', () => {
    const queue = setup();
    expect(queue.getCrossfade(7)).toBe(0);
    expect(() => queue.setCrossfade(0, -1)).toThrow(RangeError);
    expect(() => queue.setCrossfade(0, Infinity)).toThrow(RangeError);
  });
});
