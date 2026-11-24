import * as api from '../src/default-queue';
import { QueueEngine } from '../src/engine';
import * as onQueue from '../src/queue';
import { setQueueConfig } from '../src/queue';
import { getDefaultAudioQueue } from '../src/default-queue';
import { FakeAudio, flush, installFakeAudio } from './helpers/fake-audio';

/** The queue functions of src/queue.ts: every export except createAudioQueue. */
const queueFunctions = (): string[] =>
  Object.keys(onQueue).filter((name) => name !== 'createAudioQueue');

beforeEach(async () => {
  jest.useFakeTimers();
  installFakeAudio();
  setQueueConfig(getDefaultAudioQueue(), { logger: null });
  await api.destroyAllChannels();
});

afterEach(() => jest.useRealTimers());

describe('getDefaultAudioQueue', () => {
  test('returns the same lazily created instance every time', () => {
    const queue = getDefaultAudioQueue();
    expect(queue).toBeInstanceOf(QueueEngine);
    expect(getDefaultAudioQueue()).toBe(queue);
  });
});

describe('top-level functions', () => {
  test('there is exactly one top-level function per queue function', () => {
    const exported = Object.keys(api)
      .filter((name) => name !== 'getDefaultAudioQueue')
      .sort();
    expect(exported.length).toBeGreaterThan(50);
    expect(exported).toEqual(queueFunctions().sort());
  });

  test('works end to end without creating a queue explicitly', async () => {
    const started = jest.fn();
    const unsubscribe = api.onAudioStart(0, started);
    const item = await api.queueAudio('/a.mp3');
    await flush();
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'a.mp3' }));
    expect(api.getQueueLength()).toBe(1);
    unsubscribe();
    FakeAudio.instances[0]?.finish();
    await expect(item.finished).resolves.toBe('ended');
  });

  test('explicitly exercises every generated wrapper once', async () => {
    api.setQueueConfig({ prefetchCount: 1 });
    expect(api.getQueueConfig().prefetchCount).toBe(1);
    api.setChannelQueueLimit(0, 10);
    expect(api.getWebAudioSupport().available).toBe(false);
    await api.queueAudio('/a.mp3');
    await api.queueAudioPriority('/b.mp3');
    await api.queueAudio('/c.mp3');
    expect((await api.reorderQueue(2, 1)).success).toBe(true);
    expect((await api.swapQueueItems(1, 2)).success).toBe(true);
    expect((await api.removeQueuedItem(2)).success).toBe(true);
    expect(api.getQueueItemInfo(0)?.fileName).toBe('a.mp3');
    expect(api.getQueueSnapshot()?.totalItems).toBe(2);
    expect(api.getCurrentAudioInfo()?.fileName).toBe('a.mp3');
    expect(api.getAllChannelsInfo()).toHaveLength(1);
    await api.pauseChannel();
    expect(api.isChannelPaused()).toBe(true);
    await api.resumeChannel();
    await api.togglePauseChannel();
    await api.togglePauseChannel();
    await api.pauseAllChannels();
    await api.resumeAllChannels();
    await api.togglePauseAllChannels();
    await api.togglePauseAllChannels();
    expect(api.getAllChannelsPauseState()).toEqual([false]);
    void api.pauseWithFade(undefined, 0, 0);
    void api.resumeWithFade(undefined, 0, 0);
    void api.togglePauseWithFade(undefined, 0, 0);
    void api.pauseAllWithFade(undefined, 0);
    void api.resumeAllWithFade(undefined, 0);
    void api.togglePauseAllWithFade(undefined, 0);
    await api.setChannelVolume(0, 0.5);
    await api.transitionVolume(0, 0.4, 0);
    api.cancelVolumeTransition(0);
    api.cancelAllVolumeTransitions();
    expect(api.getChannelVolume()).toBeCloseTo(0.4);
    expect(api.getAllChannelsVolume()).toHaveLength(1);
    await api.setAllChannelsVolume(1);
    await api.setGlobalVolume(0.9);
    expect(api.getGlobalVolume()).toBe(0.9);
    api.setMuted(true);
    expect(api.isMuted()).toBe(true);
    api.setMuted(false);
    api.setChannelMuted(0, true);
    expect(api.isChannelMuted(0)).toBe(true);
    api.setChannelMuted(0, false);
    api.setChannelPan(0, 0);
    expect(api.getChannelPan(0)).toBe(0);
    expect(api.getChannelAnalyser(0)).toBeUndefined(); // no AudioContext in this test
    api.setVolumeDucking({ duckingVolume: 0.2, priorityChannel: 1, priorityVolume: 1 });
    api.clearVolumeDucking();
    api.unlockAudio();
    const listeners = [
      api.onAudioProgress(0, jest.fn()),
      api.onQueueChange(0, jest.fn()),
      api.onAudioComplete(0, jest.fn()),
      api.onAudioPause(0, jest.fn()),
      api.onAudioResume(0, jest.fn()),
      api.onAudioError(0, jest.fn())
    ];
    listeners.forEach((off) => off());
    api.offAudioProgress();
    api.offQueueChange();
    api.offAudioStart();
    api.offAudioComplete();
    api.offAudioPause();
    api.offAudioResume();
    api.offAudioError();
    api.setPlaybackRate(0, 1.5);
    expect(api.getPlaybackRate(0)).toBe(1.5);
    api.setRepeatMode(0, 'all');
    expect(api.getRepeatMode(0)).toBe('all');
    api.setRepeatMode(0, 'off');
    api.setChannelGap(0, 0);
    expect(api.getChannelGap(0)).toBe(0);
    expect(api.seekTo(0, 0)).toBe(true);
    expect(api.seekBy(0, 0)).toBe(true);
    expect((await api.shuffleQueue(0)).success).toBe(true);
    expect(Array.isArray(api.getHistory(0))).toBe(true);
    api.clearHistory(0);
    api.setCrossfade(0, 500);
    expect(api.getCrossfade(0)).toBe(500);
    api.setCrossfade(0, 0);
    const offCue = api.onAudioCue(0, jest.fn());
    offCue();
    api.offAudioCue(0);
    await api.clearQueueAfterCurrent();
    await api.stopCurrentAudioInChannel();
    await api.stopAllAudioInChannel();
    await api.stopAllAudio();
    await api.destroyChannel(0);
    await api.setGlobalVolume(1);
    expect(api.getQueueLength()).toBe(0);
  });
});
