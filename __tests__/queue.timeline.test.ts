/**
 * @fileoverview Features driven by the playback position: segments (endAt), segment loops, cues
 * and crossfades. FakeAudio's media clock advances currentTime with fake time while playing.
 */
import {
  createAudioQueue,
  getCrossfade,
  getCurrentAudioInfo,
  getQueueLength,
  getQueueSnapshot,
  isChannelPaused,
  offAudioCue,
  onAudioComplete,
  onAudioCue,
  onAudioError,
  pauseChannel,
  pauseWithFade,
  queueAudio,
  resumeChannel,
  seekTo,
  setChannelMuted,
  setCrossfade,
  setMuted,
  setRepeatMode,
  stopAllAudio,
  stopAllAudioInChannel
} from '../src/queue';
import type { AudioQueue } from '../src/queue';
import type { AudioCueInfo, QueueConfig } from '../src/types';
import {
  DESKTOP_UA,
  FakeAudio,
  advance,
  audioAt,
  callArg,
  flush,
  installFakeAudio,
  removeAudioContext,
  setUserAgent
} from './helpers/fake-audio';

const setup = (config: Partial<QueueConfig> = {}): AudioQueue =>
  createAudioQueue({ logger: null, ...config });

const names = (queue: AudioQueue, channel = 0): string[] =>
  getQueueSnapshot(queue, channel)?.items.map((item) => item.fileName) ?? [];

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
    onAudioComplete(queue, 0, complete);
    const item = await queueAudio(queue, '/sprite.mp3', 0, { endAt: 1300, startAt: 1000 });
    await queueAudio(queue, '/next.mp3');
    await flush();
    expect(audioAt(0).currentTime).toBe(1);
    await advance(280, 10);
    expect(complete).not.toHaveBeenCalled();
    await advance(30, 10);
    expect(callArg(complete)).toMatchObject({ fileName: 'sprite.mp3', reason: 'ended' });
    await expect(item.finished).resolves.toBe('ended');
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('endAt respects the playback rate', async () => {
    const queue = setup();
    const complete = jest.fn();
    onAudioComplete(queue, 0, complete);
    await queueAudio(queue, '/a.mp3', 0, { endAt: 400, playbackRate: 2 });
    await flush();
    await advance(190, 10);
    expect(complete).not.toHaveBeenCalled();
    await advance(20, 10);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('a startAt seek the browser ignored is retried once, with a warning', async () => {
    const warn = jest.fn();
    const queue = setup({ logger: { error: jest.fn(), warn } });
    FakeAudio.ignoredSeeks = 2; // the seek before play() and the one on loadedmetadata
    await queueAudio(queue, '/sprite.mp3', 0, { endAt: 1300, startAt: 1000 });
    await flush();
    expect(audioAt(0).currentTime).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(callArg(warn))).toMatch(
      /sprite\.mp3 did not start at 1000 ms: no HTTP Range support/
    );
  });

  test('a startAt seek that worked logs nothing', async () => {
    const warn = jest.fn();
    const queue = setup({ logger: { error: jest.fn(), warn } });
    await queueAudio(queue, '/sprite.mp3', 0, { endAt: 1300, startAt: 1000 });
    await flush();
    expect(audioAt(0).currentTime).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test('pausing freezes the segment; resuming finishes it', async () => {
    const queue = setup();
    const complete = jest.fn();
    onAudioComplete(queue, 0, complete);
    await queueAudio(queue, '/a.mp3', 0, { endAt: 300 });
    await flush();
    await advance(100, 10);
    await pauseChannel(queue);
    await advance(2000, 100);
    expect(complete).not.toHaveBeenCalled();
    await resumeChannel(queue);
    audioAt(0).startPlaying();
    await advance(220, 10);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('a looping segment jumps back to its start instead of ending', async () => {
    const queue = setup();
    const complete = jest.fn();
    onAudioComplete(queue, 0, complete);
    await queueAudio(queue, '/loop.mp3', 0, { endAt: 1500, loop: true, startAt: 1000 });
    await flush();
    expect(audioAt(0).loop).toBe(false);
    await advance(520, 10);
    expect(complete).not.toHaveBeenCalled();
    expect(audioAt(0).currentTime).toBeGreaterThanOrEqual(1);
    expect(audioAt(0).currentTime).toBeLessThan(1.1);
  });

  test('repeat "one" replays the segment from its start', async () => {
    const queue = setup();
    setRepeatMode(queue, 0, 'one');
    await queueAudio(queue, '/a.mp3', 0, { endAt: 2300, startAt: 2000 });
    await flush();
    await advance(320, 10);
    expect(audioAt(0).playCalls).toBe(2);
    expect(audioAt(0).currentTime).toBeCloseTo(2, 1);
  });

  test('repeat "all" keeps the segment on the copy', async () => {
    const queue = setup();
    setRepeatMode(queue, 0, 'all');
    await queueAudio(queue, '/a.mp3', 0, { endAt: 500, startAt: 200 });
    await queueAudio(queue, '/b.mp3');
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
    await queueAudio(queue, '/a.mp3');
    await flush();
    await advance(500, 50);
    expect(getQueueLength(queue)).toBe(1);
  });

  test.each([
    [{ endAt: 100, startAt: 100 }],
    [{ endAt: 50, startAt: 100 }],
    [{ endAt: NaN }],
    [{ endAt: Infinity }]
  ])('rejects an invalid segment %p', async (options) => {
    await expect(queueAudio(setup(), '/a.mp3', 0, options)).rejects.toThrow(RangeError);
  });
});

describe('cues', () => {
  const collect = (queue: AudioQueue): AudioCueInfo[] => {
    const seen: AudioCueInfo[] = [];
    onAudioCue(queue, 0, (info) => seen.push(info));
    return seen;
  };

  test('ranged cues fire on enter and exit, point cues once, all at the right time', async () => {
    const queue = setup();
    const seen = collect(queue);
    await queueAudio(queue, '/talk.mp3', 0, {
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
    await queueAudio(queue, '/a.mp3', 0, { cues: [late, early] });
    await flush();
    await advance(400, 10);
    expect(seen.map((s) => s.cue)).toEqual([early, late]);
    expect(seen[1]?.cue).toBe(late);
  });

  test('a cue at 0 fires as playback starts', async () => {
    const queue = setup();
    const seen = collect(queue);
    await queueAudio(queue, '/a.mp3', 0, { cues: [{ startMs: 0, text: 'start' }] });
    await flush();
    expect(seen).toHaveLength(1);
  });

  test('seeking back replays point cues; seeking into a range enters it', async () => {
    const queue = setup();
    const seen = collect(queue);
    await queueAudio(queue, '/a.mp3', 0, {
      cues: [{ startMs: 200 }, { endMs: 5000, startMs: 4000 }]
    });
    await flush();
    await advance(300, 10);
    expect(seen).toHaveLength(1);
    seekTo(queue, 0, 0);
    await advance(300, 10);
    expect(seen).toHaveLength(2);
    seekTo(queue, 0, 4500);
    expect(seen[2]).toMatchObject({ active: true, index: 1 });
    seekTo(queue, 0, 6000);
    expect(seen[3]).toMatchObject({ active: false, index: 1 });
  });

  test('active cues are exited when the item stops', async () => {
    const queue = setup();
    const seen = collect(queue);
    await queueAudio(queue, '/a.mp3', 0, { cues: [{ endMs: 5000, startMs: 0, text: 'x' }] });
    await flush();
    expect(seen.map((s) => s.active)).toEqual([true]);
    await stopAllAudioInChannel(queue);
    expect(seen.map((s) => s.active)).toEqual([true, false]);
  });

  test('cues update while paused when the user seeks', async () => {
    const queue = setup();
    const seen = collect(queue);
    await queueAudio(queue, '/a.mp3', 0, { cues: [{ endMs: 3000, startMs: 2000 }] });
    await flush();
    await pauseChannel(queue);
    seekTo(queue, 0, 2500);
    expect(seen.map((s) => s.active)).toEqual([true]);
  });

  test('offAudioCue removes listeners; subscriptions validate the channel', async () => {
    const queue = setup();
    const listener = jest.fn();
    onAudioCue(queue, 0, listener);
    offAudioCue(queue, 0, listener);
    const other = jest.fn();
    onAudioCue(queue, 0, other);
    offAudioCue(queue);
    await queueAudio(queue, '/a.mp3', 0, { cues: [{ startMs: 0 }] });
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    expect(() => onAudioCue(queue, 99, jest.fn())).toThrow(RangeError);
  });

  test.each([
    [[{ startMs: -1 }]],
    [[{ startMs: NaN }]],
    [[{ endMs: 100, startMs: 100 }]],
    [[{ endMs: Infinity, startMs: 0 }]]
  ])('rejects invalid cues %p', async (cues) => {
    await expect(queueAudio(setup(), '/a.mp3', 0, { cues })).rejects.toThrow(RangeError);
  });
});

describe('crossfade', () => {
  test('the next item starts early and fades in while the current one fades out', async () => {
    const queue = setup();
    const complete = jest.fn();
    onAudioComplete(queue, 0, complete);
    setCrossfade(queue, 0, 1000);
    expect(getCrossfade(queue, 0)).toBe(1000);
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await flush();
    const [a, b] = [audioAt(0), audioAt(1)];
    await advance(8990, 100);
    expect(b.playCalls).toBe(0);
    await advance(20, 10);
    expect(b.playCalls).toBe(1);
    expect(callArg(complete)).toMatchObject({ fileName: 'a.mp3', reason: 'ended' });
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

  test('muting during a crossfade silences the fading item at once', async () => {
    const queue = setup();
    setCrossfade(queue, 0, 1000);
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await flush();
    const [a, b] = [audioAt(0), audioAt(1)];
    await advance(9300, 100);
    expect(a.volume).toBeGreaterThan(0);
    setMuted(queue, true);
    expect(a.src).toBe('');
    expect(b.volume).toBe(0);
    await advance(800, 16);
    expect(b.volume).toBe(0);
    setMuted(queue, false);
    expect(b.volume).toBeCloseTo(1);
  });

  test('muting another channel leaves a crossfade alone', async () => {
    const queue = setup();
    setCrossfade(queue, 0, 1000);
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await flush();
    await advance(9300, 100);
    setChannelMuted(queue, 1, true);
    expect(audioAt(0).src).not.toBe('');
  });

  test('is limited to half of a short item', async () => {
    const queue = setup();
    setCrossfade(queue, 0, 5000);
    await queueAudio(queue, '/short.mp3', 0, { endAt: 2000 });
    await queueAudio(queue, '/b.mp3');
    await flush();
    await advance(990, 10);
    expect(audioAt(1).playCalls).toBe(0);
    await advance(20, 10);
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('does not crossfade the last item, loops, or repeat-one', async () => {
    const queue = setup();
    setCrossfade(queue, 0, 1000);
    await queueAudio(queue, '/only.mp3');
    await flush();
    await advance(9500, 100);
    expect(getQueueLength(queue)).toBe(1);
    const looping = setup();
    setCrossfade(looping, 0, 1000);
    await queueAudio(looping, '/loop.mp3', 0, { loop: true });
    await queueAudio(looping, '/b.mp3');
    await flush();
    await advance(9500, 100);
    expect(getQueueLength(looping)).toBe(2);
    const one = setup();
    setCrossfade(one, 0, 1000);
    setRepeatMode(one, 0, 'one');
    await queueAudio(one, '/a.mp3');
    await queueAudio(one, '/b.mp3');
    await flush();
    await advance(9500, 100);
    expect(getQueueLength(one)).toBe(2);
  });

  test('with repeat "all" a single item crossfades into its own copy', async () => {
    const queue = setup();
    setCrossfade(queue, 0, 1000);
    setRepeatMode(queue, 0, 'all');
    await queueAudio(queue, '/a.mp3');
    await flush();
    await advance(9100, 100);
    expect(FakeAudio.instances).toHaveLength(2);
    expect(names(queue)).toEqual(['a.mp3']);
  });

  test('pausing during a crossfade cuts the outgoing item', async () => {
    const queue = setup();
    setCrossfade(queue, 0, 1000);
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await flush();
    await advance(9200, 100);
    await pauseChannel(queue);
    expect(audioAt(0).src).toBe('');
    expect(isChannelPaused(queue)).toBe(true);
  });

  test('stopping during a crossfade releases both items', async () => {
    const queue = setup();
    setCrossfade(queue, 0, 1000);
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await flush();
    await advance(9200, 100);
    await stopAllAudio(queue);
    expect(FakeAudio.instances.every((audio) => audio.src === '')).toBe(true);
  });

  test('an error on the outgoing item just releases it', async () => {
    const queue = setup();
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    setCrossfade(queue, 0, 1000);
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await flush();
    await advance(9200, 100);
    audioAt(0).fail(2);
    expect(errors).not.toHaveBeenCalled();
    expect(audioAt(0).src).toBe('');
    expect(getCurrentAudioInfo(queue)?.fileName).toBe('b.mp3');
  });

  test('a pause still fading out is not interrupted by a crossfade', async () => {
    const queue = setup();
    setCrossfade(queue, 0, 1000);
    await queueAudio(queue, '/a.mp3');
    await queueAudio(queue, '/b.mp3');
    await flush();
    await advance(8800, 100);
    void pauseWithFade(queue, undefined, 0, 2000);
    await advance(300, 50);
    expect(audioAt(1).playCalls).toBe(0);
  });

  test('validates the length', () => {
    const queue = setup();
    expect(getCrossfade(queue, 7)).toBe(0);
    expect(() => setCrossfade(queue, 0, -1)).toThrow(RangeError);
    expect(() => setCrossfade(queue, 0, Infinity)).toThrow(RangeError);
  });
});
