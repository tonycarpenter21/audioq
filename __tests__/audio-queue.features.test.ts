/**
 * @fileoverview Tests for the v3 feature set: Blob sources, metadata, interrupt, dedupe, playback
 * rate, start position, seeking, repeat modes, shuffle, gaps, history, external pause/play and
 * pause-when-hidden.
 */
import { createAudioQueue } from '../src/audio-queue';
import type { AudioQueue } from '../src/audio-queue';
import type { QueueConfig } from '../src/types';
import {
  DESKTOP_UA,
  FakeAudio,
  advance,
  audioAt,
  callArg,
  flush,
  installFakeAudio,
  installObjectUrls,
  removeAudioContext,
  setPageHidden,
  setUserAgent
} from './helpers/fake-audio';

const setup = (config: Partial<QueueConfig> = {}): AudioQueue =>
  createAudioQueue({ logger: null, ...config });

const names = (queue: AudioQueue, channel = 0): string[] =>
  queue.getQueueSnapshot(channel)?.items.map((item) => item.fileName) ?? [];

const playing = async (queue: AudioQueue, ...files: string[]): Promise<void> => {
  for (const file of files) await queue.queueAudio(file);
  await flush();
};

beforeEach(() => {
  jest.useFakeTimers();
  installFakeAudio();
  removeAudioContext();
  setUserAgent(DESKTOP_UA);
});

afterEach(() => {
  jest.useRealTimers();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

describe('Blob and File sources', () => {
  test('a Blob gets an object URL that is revoked when the item is released', async () => {
    const urls = installObjectUrls();
    const queue = setup();
    const item = await queue.queueAudio(new Blob(['x'], { type: 'audio/wav' }));
    expect(urls.create).toHaveBeenCalledTimes(1);
    expect(item.src).toMatch(/^blob:/);
    expect(audioAt(0).src).toBe(item.src);
    expect(urls.revoke).not.toHaveBeenCalled();
    await flush();
    audioAt(0).finish();
    await flush();
    expect(urls.revoke).toHaveBeenCalledWith(item.src);
  });

  test('a File keeps its name; a bare Blob uses metadata.title or "audio"', async () => {
    installObjectUrls();
    const queue = setup();
    await queue.queueAudio(new File(['x'], 'voice note.webm'));
    await queue.queueAudio(new Blob(['y']), 0, { metadata: { title: 'Reply 2' } });
    await queue.queueAudio(new Blob(['z']));
    expect(names(queue)).toEqual(['voice note.webm', 'Reply 2', 'audio']);
  });

  test('removed and stopped Blob items are revoked too', async () => {
    const urls = installObjectUrls();
    const queue = setup();
    await queue.queueAudio(new Blob(['a']));
    await queue.queueAudio(new Blob(['b']));
    await queue.stopAllAudioInChannel();
    expect(urls.revoke).toHaveBeenCalledTimes(2);
  });

  test('rejects values that are neither a URL nor a Blob', async () => {
    await expect(setup().queueAudio({} as unknown as string)).rejects.toThrow(TypeError);
  });
});

describe('metadata', () => {
  test('travels with the item through handle, snapshot, info, events and history', async () => {
    const queue = setup();
    const metadata = { artist: 'Ada', messageId: 'm-42', title: 'Welcome' };
    const seen: unknown[] = [];
    queue.onAudioStart(0, (info) => seen.push(['start', info.metadata, info.id]));
    queue.onAudioComplete(0, (info) => seen.push(['complete', info.metadata, info.playedMs]));
    const item = await queue.queueAudio('/welcome.mp3', 0, { metadata });
    await flush();
    expect(item.metadata).toBe(metadata);
    expect(queue.getQueueSnapshot()?.items[0]?.metadata).toBe(metadata);
    expect(queue.getCurrentAudioInfo()?.metadata).toBe(metadata);
    audioAt(0).finish();
    await flush();
    expect(seen).toEqual([
      ['start', metadata, item.id],
      ['complete', metadata, 10000]
    ]);
    expect(queue.getHistory()[0]?.metadata).toBe(metadata);
  });

  test('is included in error events', async () => {
    const queue = setup();
    const errors = jest.fn();
    queue.onAudioError(0, errors);
    await queue.queueAudio('/broken.mp3', 0, { metadata: { title: 'Broken' } });
    audioAt(0).fail(4);
    expect(callArg(errors)).toMatchObject({ metadata: { title: 'Broken' } });
  });
});

describe('interrupt', () => {
  test('stops the current item, clears the channel, and plays the new one now', async () => {
    const queue = setup();
    const complete = jest.fn();
    queue.onAudioComplete(0, complete);
    await playing(queue, '/a.mp3', '/b.mp3', '/c.mp3');
    const waiting = queue.getQueueSnapshot()?.items[1];
    const urgent = await queue.queueAudio('/urgent.mp3', 0, { interrupt: true });
    expect(names(queue)).toEqual(['urgent.mp3']);
    expect(callArg(complete)).toMatchObject({ fileName: 'a.mp3', reason: 'stopped' });
    expect(waiting?.fileName).toBe('b.mp3');
    await expect(urgent.started).resolves.toBe(true);
  });

  test('works on a paused channel and unpauses it', async () => {
    const queue = setup();
    await playing(queue, '/a.mp3');
    await queue.pauseChannel();
    await queue.queueAudio('/now.mp3', 0, { interrupt: true });
    expect(queue.isChannelPaused()).toBe(false);
    expect(queue.getCurrentAudioInfo()?.fileName).toBe('now.mp3');
  });
});

describe('dedupeMs', () => {
  test('ignores the same source within the window', async () => {
    const queue = setup();
    const first = await queue.queueAudio('/ping.mp3', 0, { dedupeMs: 1000 });
    const second = await queue.queueAudio('/ping.mp3', 0, { dedupeMs: 1000 });
    expect(queue.getQueueLength()).toBe(1);
    await expect(second.finished).resolves.toBe('skipped');
    await expect(second.started).resolves.toBe(false);
    expect(second.id).not.toBe(first.id);
  });

  test('allows the source again after the window and never blocks other sources', async () => {
    const queue = setup();
    await queue.queueAudio('/ping.mp3', 0, { dedupeMs: 1000 });
    await queue.queueAudio('/other.mp3', 0, { dedupeMs: 1000 });
    jest.advanceTimersByTime(1001);
    await queue.queueAudio('/ping.mp3', 0, { dedupeMs: 1000 });
    expect(names(queue)).toEqual(['ping.mp3', 'other.mp3', 'ping.mp3']);
  });

  test('is per channel, and relative and absolute URLs of the same file match', async () => {
    const queue = setup();
    await queue.queueAudio('/ping.mp3', 0, { dedupeMs: 1000 });
    await queue.queueAudio('http://localhost/ping.mp3', 0, { dedupeMs: 1000 });
    await queue.queueAudio('/ping.mp3', 1, { dedupeMs: 1000 });
    expect(queue.getQueueLength(0)).toBe(1);
    expect(queue.getQueueLength(1)).toBe(1);
  });

  test('does nothing without dedupeMs', async () => {
    const queue = setup();
    await queue.queueAudio('/ping.mp3');
    await queue.queueAudio('/ping.mp3');
    expect(queue.getQueueLength()).toBe(2);
  });
});

describe('playback rate', () => {
  test('item rate × channel rate is applied with pitch preserved', async () => {
    const queue = setup();
    queue.setPlaybackRate(0, 2);
    await queue.queueAudio('/a.mp3', 0, { playbackRate: 0.75 });
    expect(audioAt(0).playbackRate).toBeCloseTo(1.5);
    expect(audioAt(0).preservesPitch).toBe(true);
    expect(queue.getCurrentAudioInfo()?.playbackRate).toBeCloseTo(1.5);
    expect(queue.getQueueItemInfo(0)?.playbackRate).toBe(0.75);
    queue.setPlaybackRate(0, 1);
    expect(audioAt(0).playbackRate).toBeCloseTo(0.75);
  });

  test('rates are clamped to 0.25-4 and invalid values mean 1', async () => {
    const queue = setup();
    queue.setPlaybackRate(0, 10);
    expect(queue.getPlaybackRate(0)).toBe(4);
    queue.setPlaybackRate(0, 0.01);
    expect(queue.getPlaybackRate(0)).toBe(0.25);
    queue.setPlaybackRate(0, NaN);
    expect(queue.getPlaybackRate(0)).toBe(1);
    expect(queue.getPlaybackRate(9)).toBe(1);
    await queue.queueAudio('/a.mp3', 0, { playbackRate: Infinity });
    expect(queue.getQueueItemInfo(0)?.playbackRate).toBe(1);
  });
});

describe('startAt and seeking', () => {
  test('startAt begins playback part-way through', async () => {
    const queue = setup();
    await queue.queueAudio('/podcast.mp3', 0, { startAt: 90000 });
    expect(audioAt(0).currentTime).toBe(90);
  });

  test('startAt is reapplied when metadata loads, but not after playback started', async () => {
    FakeAudio.defaultPlayBehavior = 'resolve-silently';
    const queue = setup();
    await queue.queueAudio('/podcast.mp3', 0, { startAt: 5000 });
    const audio = audioAt(0);
    audio.currentTime = 0;
    audio.fire('loadedmetadata');
    expect(audio.currentTime).toBe(5);
    audio.startPlaying();
    audio.currentTime = 8;
    audio.fire('loadedmetadata');
    expect(audio.currentTime).toBe(8);
  });

  test('startAt ignores negative and invalid values', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3', 0, { startAt: -5 });
    await queue.queueAudio('/b.mp3', 1, { startAt: NaN });
    expect(audioAt(0).currentTime).toBe(0);
    expect(audioAt(1).currentTime).toBe(0);
  });

  test('an unseekable element does not break startAt', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3', 0, { startAt: 1000, metadata: undefined });
    const audio = audioAt(0);
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => 0,
      set: () => {
        throw new Error('InvalidStateError');
      }
    });
    expect(() => audio.fire('loadedmetadata')).not.toThrow();
  });

  test('seekTo clamps to the duration; seekBy moves relative to now', async () => {
    const queue = setup();
    await playing(queue, '/a.mp3');
    expect(queue.seekTo(0, 4000)).toBe(true);
    expect(audioAt(0).currentTime).toBe(4);
    expect(queue.seekBy(0, 15000)).toBe(true);
    expect(audioAt(0).currentTime).toBe(10);
    expect(queue.seekBy(0, -30000)).toBe(true);
    expect(audioAt(0).currentTime).toBe(0);
  });

  test('seeking without an item or with an invalid position does nothing', async () => {
    const queue = setup();
    expect(queue.seekTo(0, 1000)).toBe(false);
    expect(queue.seekBy(0, 1000)).toBe(false);
    await playing(queue, '/a.mp3');
    expect(queue.seekTo(0, NaN)).toBe(false);
    expect(queue.seekBy(0, Infinity)).toBe(false);
  });

  test('seekTo works before the duration is known', async () => {
    FakeAudio.defaultPlayBehavior = 'resolve-silently';
    const queue = setup();
    await queue.queueAudio('/live.mp3');
    expect(queue.seekTo(0, 3000)).toBe(true);
    expect(audioAt(0).currentTime).toBe(3);
  });
});

describe('repeat modes', () => {
  test('"one" replays the current item, reporting each play-through', async () => {
    const queue = setup();
    const starts = jest.fn();
    const completes = jest.fn();
    queue.onAudioStart(0, starts);
    queue.onAudioComplete(0, completes);
    queue.setRepeatMode(0, 'one');
    await playing(queue, '/loop.mp3', '/next.mp3');
    audioAt(0).finish();
    await flush();
    expect(names(queue)).toEqual(['loop.mp3', 'next.mp3']);
    expect(audioAt(0).playCalls).toBe(2);
    expect(audioAt(0).currentTime).toBe(0);
    expect(callArg(completes)).toMatchObject({ reason: 'ended', remainingInQueue: 1 });
    expect(starts).toHaveBeenCalledTimes(2);
    expect(queue.getHistory()).toHaveLength(1);
  });

  test('"all" moves each finished item to the end so the queue cycles', async () => {
    const queue = setup();
    queue.setRepeatMode(0, 'all');
    await playing(queue, '/a.mp3', '/b.mp3');
    audioAt(0).finish();
    await flush();
    expect(names(queue)).toEqual(['b.mp3', 'a.mp3']);
    FakeAudio.instances.find((audio) => audio.src.endsWith('b.mp3'))?.finish();
    await flush();
    expect(names(queue)).toEqual(['a.mp3', 'b.mp3']);
  });

  test('"all" keeps a Blob item playable across cycles and revokes its URL once', async () => {
    const urls = installObjectUrls();
    const queue = setup();
    queue.setRepeatMode(0, 'all');
    await queue.queueAudio(new Blob(['a']));
    await flush();
    audioAt(0).finish();
    await flush();
    expect(urls.revoke).not.toHaveBeenCalled();
    expect(queue.getQueueLength()).toBe(1);
    queue.setRepeatMode(0, 'off');
    audioAt(1).finish();
    await flush();
    expect(urls.revoke).toHaveBeenCalledTimes(1);
  });

  test('"all" does not repeat stopped or failed items', async () => {
    const queue = setup();
    queue.setRepeatMode(0, 'all');
    await playing(queue, '/a.mp3', '/b.mp3');
    await queue.stopCurrentAudioInChannel();
    expect(names(queue)).toEqual(['b.mp3']);
  });

  test('validates the mode and reports the default', () => {
    const queue = setup();
    expect(queue.getRepeatMode(3)).toBe('off');
    expect(() => queue.setRepeatMode(0, 'sometimes' as 'one')).toThrow(RangeError);
    queue.setRepeatMode(3, 'all');
    expect(queue.getRepeatMode(3)).toBe('all');
  });
});

describe('shuffleQueue', () => {
  test('shuffles waiting items only, reproducibly with a custom random source', async () => {
    const queue = setup();
    await playing(queue, '/a.mp3', '/b.mp3', '/c.mp3', '/d.mp3');
    const values = [0.9, 0.1, 0.5];
    const result = await queue.shuffleQueue(0, () => values.shift() ?? 0);
    expect(result.success).toBe(true);
    expect(names(queue)[0]).toBe('a.mp3');
    expect([...names(queue)].sort()).toEqual(['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3']);
    expect(names(queue)).toEqual(['a.mp3', 'c.mp3', 'b.mp3', 'd.mp3']);
  });

  test('with Math.random keeps every item', async () => {
    const queue = setup();
    await playing(queue, '/a.mp3', '/b.mp3', '/c.mp3', '/d.mp3', '/e.mp3');
    await queue.shuffleQueue();
    expect([...names(queue)].sort()).toEqual(['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3']);
  });

  test('short queues and unknown channels are fine', async () => {
    const queue = setup();
    expect((await queue.shuffleQueue(7)).updatedQueue?.totalItems).toBe(0);
    await playing(queue, '/a.mp3', '/b.mp3');
    const changes = jest.fn();
    queue.onQueueChange(0, changes);
    await queue.shuffleQueue();
    expect(changes).not.toHaveBeenCalled();
  });
});

describe('gaps between items', () => {
  test('the next item waits gapMs before starting', async () => {
    const queue = setup();
    queue.setChannelGap(0, 2000);
    expect(queue.getChannelGap(0)).toBe(2000);
    await playing(queue, '/a.mp3', '/b.mp3');
    audioAt(0).finish();
    await flush();
    expect(audioAt(1).playCalls).toBe(0);
    await advance(1999, 500);
    expect(audioAt(1).playCalls).toBe(0);
    await advance(10, 10);
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('pausing during a gap keeps the channel paused; resuming waits for the gap', async () => {
    const queue = setup();
    queue.setChannelGap(0, 1000);
    await playing(queue, '/a.mp3', '/b.mp3');
    audioAt(0).finish();
    await flush();
    await queue.pauseChannel();
    await advance(1500, 500);
    expect(audioAt(1).playCalls).toBe(0);
    await queue.resumeChannel();
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('resuming during a gap does not start early', async () => {
    const queue = setup();
    queue.setChannelGap(0, 1000);
    await playing(queue, '/a.mp3', '/b.mp3');
    audioAt(0).finish();
    await flush();
    await queue.pauseChannel();
    await queue.resumeChannel();
    expect(audioAt(1).playCalls).toBe(0);
    await advance(1100, 100);
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('stopping clears a pending gap', async () => {
    const queue = setup();
    queue.setChannelGap(0, 1000);
    await playing(queue, '/a.mp3', '/b.mp3');
    audioAt(0).finish();
    await flush();
    await queue.stopAllAudioInChannel();
    await queue.queueAudio('/c.mp3');
    expect(audioAt(2).playCalls).toBe(1);
  });

  test('no gap after the last item; invalid gaps are rejected', async () => {
    const queue = setup();
    queue.setChannelGap(0, 1000);
    await playing(queue, '/a.mp3');
    audioAt(0).finish();
    await flush();
    await queue.queueAudio('/b.mp3');
    expect(audioAt(1).playCalls).toBe(1);
    expect(() => queue.setChannelGap(0, -1)).toThrow(RangeError);
    expect(() => queue.setChannelGap(0, NaN)).toThrow(RangeError);
    expect(queue.getChannelGap(5)).toBe(0);
  });
});

describe('history', () => {
  test('records finished items with reason and played time, oldest first', async () => {
    const queue = setup();
    await playing(queue, '/a.mp3', '/b.mp3', '/c.mp3');
    audioAt(0).finish();
    await flush();
    audioAt(1).currentTime = 2.5;
    await queue.stopCurrentAudioInChannel();
    const history = queue.getHistory();
    expect(history.map((entry) => [entry.fileName, entry.reason, entry.playedMs])).toEqual([
      ['a.mp3', 'ended', 10000],
      ['b.mp3', 'stopped', 2500]
    ]);
    expect(history[0]).toMatchObject({ channelNumber: 0, src: 'http://localhost/a.mp3' });
    expect(typeof history[0]?.finishedAt).toBe('number');
  });

  test('keeps at most historySize entries; 0 disables it', async () => {
    const queue = setup({ historySize: 2 });
    await playing(queue, '/a.mp3', '/b.mp3', '/c.mp3', '/d.mp3');
    for (let i = 0; i < 3; i++) await queue.stopCurrentAudioInChannel();
    expect(queue.getHistory().map((entry) => entry.fileName)).toEqual(['b.mp3', 'c.mp3']);
    const off = setup({ historySize: 0 });
    await playing(off, '/a.mp3');
    await off.stopCurrentAudioInChannel();
    expect(off.getHistory()).toEqual([]);
  });

  test('errors and stopAll are recorded; removed items are not', async () => {
    const queue = setup();
    await playing(queue, '/bad.mp3', '/b.mp3', '/c.mp3');
    audioAt(0).fail(3);
    await queue.removeQueuedItem(1);
    await queue.stopAllAudioInChannel();
    expect(queue.getHistory().map((entry) => [entry.fileName, entry.reason])).toEqual([
      ['bad.mp3', 'error'],
      ['b.mp3', 'stopped']
    ]);
  });

  test('getHistory returns a copy; clearHistory empties it; unknown channels are empty', async () => {
    const queue = setup();
    await playing(queue, '/a.mp3');
    await queue.stopCurrentAudioInChannel();
    queue.getHistory().pop();
    expect(queue.getHistory()).toHaveLength(1);
    queue.clearHistory();
    expect(queue.getHistory()).toEqual([]);
    expect(queue.getHistory(9)).toEqual([]);
    queue.clearHistory(9);
  });

  test('validates historySize', () => {
    expect(() => setup({ historySize: -1 })).toThrow(RangeError);
    expect(() => setup({ historySize: 1.5 })).toThrow(RangeError);
  });
});

describe('pauses and plays started outside audioq', () => {
  test('an OS pause marks the channel paused and emits pause; resume works afterwards', async () => {
    const queue = setup();
    const pauses = jest.fn();
    queue.onAudioPause(0, pauses);
    await playing(queue, '/a.mp3');
    audioAt(0).externalPause();
    expect(queue.isChannelPaused()).toBe(true);
    expect(pauses).toHaveBeenCalledTimes(1);
    await queue.resumeChannel();
    expect(audioAt(0).playCalls).toBe(2);
    expect(queue.isChannelPaused()).toBe(false);
  });

  test('an OS play (lock screen) marks the channel playing and emits resume', async () => {
    const queue = setup();
    const resumes = jest.fn();
    queue.onAudioResume(0, resumes);
    await playing(queue, '/a.mp3');
    await queue.pauseWithFade(undefined, 0, 0);
    await queue.pauseChannel();
    audioAt(0).externalPlay();
    expect(queue.isChannelPaused()).toBe(false);
    expect(resumes).toHaveBeenCalledTimes(1);
    expect(audioAt(0).volume).toBe(1);
  });

  test('the pause browsers fire right before "ended" is not treated as a user pause', async () => {
    const queue = setup();
    const pauses = jest.fn();
    queue.onAudioPause(0, pauses);
    await playing(queue, '/a.mp3', '/b.mp3');
    audioAt(0).finish();
    await flush();
    expect(pauses).not.toHaveBeenCalled();
    expect(queue.getCurrentAudioInfo()?.fileName).toBe('b.mp3');
  });

  test('our own pause does not produce a second pause event', async () => {
    const queue = setup();
    const pauses = jest.fn();
    queue.onAudioPause(0, pauses);
    await playing(queue, '/a.mp3');
    await queue.pauseChannel();
    expect(pauses).toHaveBeenCalledTimes(1);
  });
});

describe('pauseWhenHidden', () => {
  test('pauses playing channels while hidden and resumes them when visible', async () => {
    const queue = setup({ pauseWhenHidden: true });
    await playing(queue, '/a.mp3');
    await queue.queueAudio('/b.mp3', 1);
    await queue.pauseChannel(1);
    setPageHidden(true);
    expect(queue.getAllChannelsPauseState()).toEqual([true, true]);
    setPageHidden(false);
    await flush();
    expect(queue.getAllChannelsPauseState()).toEqual([false, true]);
  });

  test('a channel resumed by the user while hidden is not touched on return', async () => {
    const queue = setup({ pauseWhenHidden: true });
    await playing(queue, '/a.mp3');
    setPageHidden(true);
    await queue.resumeChannel();
    await queue.pauseChannel();
    setPageHidden(false);
    await flush();
    expect(queue.isChannelPaused()).toBe(true);
  });

  test('is off by default and can be toggled with setQueueConfig', async () => {
    const queue = setup();
    await playing(queue, '/a.mp3');
    setPageHidden(true);
    expect(queue.isChannelPaused()).toBe(false);
    setPageHidden(false);
    queue.setQueueConfig({ pauseWhenHidden: true });
    queue.setQueueConfig({ pauseWhenHidden: true });
    setPageHidden(true);
    expect(queue.isChannelPaused()).toBe(true);
    setPageHidden(false);
    await flush();
    queue.setQueueConfig({ pauseWhenHidden: false });
    setPageHidden(true);
    expect(queue.isChannelPaused()).toBe(false);
  });
});

describe('loading state', () => {
  test('isLoading is true until the element has enough data', async () => {
    FakeAudio.defaultPlayBehavior = 'resolve-silently';
    const queue = setup();
    await queue.queueAudio('/a.mp3');
    expect(queue.getCurrentAudioInfo()?.isLoading).toBe(true);
    audioAt(0).startPlaying();
    expect(queue.getCurrentAudioInfo()?.isLoading).toBe(false);
  });
});

describe('muting', () => {
  test('setMuted silences everything and restores the exact volumes', async () => {
    const queue = setup();
    await queue.setChannelVolume(0, 0.6);
    await queue.queueAudio('/a.mp3', 0, { volume: 0.5 });
    await queue.queueAudio('/b.mp3', 1);
    await flush();
    queue.setMuted(true);
    expect(queue.isMuted()).toBe(true);
    expect(audioAt(0).volume).toBe(0);
    expect(audioAt(1).volume).toBe(0);
    expect(queue.getChannelVolume(0)).toBe(0.6);
    expect(queue.getCurrentAudioInfo(0)?.volume).toBe(0);
    expect(audioAt(0).paused).toBe(false); // muting is not pausing
    queue.setMuted(false);
    expect(queue.isMuted()).toBe(false);
    expect(audioAt(0).volume).toBeCloseTo(0.3);
    expect(audioAt(1).volume).toBeCloseTo(1);
  });

  test('items that start while muted start silent', async () => {
    const queue = setup();
    queue.setMuted(true);
    await queue.queueAudio('/a.mp3');
    await flush();
    expect(audioAt(0).volume).toBe(0);
    await queue.setGlobalVolume(0.5);
    expect(audioAt(0).volume).toBe(0);
    queue.setMuted(false);
    expect(audioAt(0).volume).toBeCloseTo(0.5);
  });

  test('setChannelMuted mutes one channel and lasts across items', async () => {
    const queue = setup();
    await queue.queueAudio('/a.mp3', 0);
    await queue.queueAudio('/b.mp3', 0);
    await queue.queueAudio('/c.mp3', 1);
    await flush();
    queue.setChannelMuted(0, true);
    expect(queue.isChannelMuted(0)).toBe(true);
    expect(queue.isChannelMuted(1)).toBe(false);
    expect(audioAt(0).volume).toBe(0);
    expect(audioAt(2).volume).toBeCloseTo(1);
    audioAt(0).finish();
    await flush();
    expect(audioAt(1).volume).toBe(0);
    queue.setChannelMuted(0, false);
    expect(audioAt(1).volume).toBeCloseTo(1);
  });

  test('a channel can be muted before it is used; unknown channels report unmuted', () => {
    const queue = setup();
    expect(queue.isChannelMuted(5)).toBe(false);
    expect(queue.isChannelMuted()).toBe(false);
    queue.setChannelMuted(5, true);
    expect(queue.isChannelMuted(5)).toBe(true);
    expect(() => queue.setChannelMuted(-1, true)).toThrow(RangeError);
  });

  test('ducking and fades still apply after unmuting', async () => {
    const queue = setup();
    queue.setVolumeDucking({ duckingVolume: 0.2, priorityChannel: 1, priorityVolume: 1 });
    await queue.queueAudio('/music.mp3', 0);
    await queue.queueAudio('/voice.mp3', 1);
    await flush();
    await advance(400);
    queue.setMuted(true);
    queue.setMuted(false);
    expect(audioAt(0).volume).toBeCloseTo(0.2);
  });

  test('destroyAllChannels unmutes', async () => {
    const queue = setup();
    queue.setMuted(true);
    await queue.destroyAllChannels();
    expect(queue.isMuted()).toBe(false);
  });
});

describe('debug log', () => {
  const debugLines = (debug: jest.Mock): string[] =>
    (debug.mock.calls as unknown[][]).map((call) => String(call[0]));

  test('debug: true logs every event but progress, with channel and payload', async () => {
    const debug = jest.fn();
    const queue = setup({ debug: true, logger: { debug, error: jest.fn(), warn: jest.fn() } });
    await queue.queueAudio('/a.mp3', 1);
    await flush();
    audioAt(0).tick(1);
    audioAt(0).finish();
    await flush();
    const lines = debugLines(debug);
    expect(lines).toContain('audioq [channel 1] queuechange');
    expect(lines).toContain('audioq [channel 1] start');
    expect(lines).toContain('audioq [channel 1] complete');
    expect(lines.some((line) => line.includes('progress'))).toBe(false);
    const complete = (debug.mock.calls as unknown[][]).find(
      (call) => call[0] === 'audioq [channel 1] complete'
    );
    expect(complete?.[1]).toMatchObject({ fileName: 'a.mp3', reason: 'ended' });
  });

  test('is off by default, and can be switched on later', async () => {
    const debug = jest.fn();
    const queue = setup({ logger: { debug, error: jest.fn(), warn: jest.fn() } });
    expect(queue.getQueueConfig().debug).toBe(false);
    await queue.queueAudio('/a.mp3');
    expect(debug).not.toHaveBeenCalled();
    queue.setQueueConfig({ debug: true });
    await queue.queueAudio('/b.mp3');
    expect(debugLines(debug)).toContain('audioq [channel 0] queuechange');
  });

  test('loggers without debug, and no logger, are fine', async () => {
    await expect(
      setup({ debug: true, logger: { error: jest.fn(), warn: jest.fn() } }).queueAudio('/a.mp3')
    ).resolves.toBeDefined();
    await expect(setup({ debug: true, logger: null }).queueAudio('/a.mp3')).resolves.toBeDefined();
  });
});
