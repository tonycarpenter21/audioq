import { AudioQueue } from '../src/audio-queue';
import * as api from '../src/default-queue';
import { getDefaultAudioQueue } from '../src/default-queue';
import { FakeAudio, flush, installFakeAudio } from './helpers/fake-audio';

/** Public AudioQueue method names, read from the class itself. */
const classMethods = (): string[] =>
  Object.getOwnPropertyNames(AudioQueue.prototype).filter(
    (name) =>
      name !== 'constructor' &&
      typeof (AudioQueue.prototype as unknown as Record<string, unknown>)[name] === 'function'
  );

beforeEach(async () => {
  jest.useFakeTimers();
  installFakeAudio();
  getDefaultAudioQueue().setQueueConfig({ logger: null });
  await api.destroyAllChannels();
});

afterEach(() => jest.useRealTimers());

describe('getDefaultAudioQueue', () => {
  test('returns the same lazily created instance every time', () => {
    const queue = getDefaultAudioQueue();
    expect(queue).toBeInstanceOf(AudioQueue);
    expect(getDefaultAudioQueue()).toBe(queue);
  });
});

describe('top-level functions', () => {
  test('there is one function per public AudioQueue method (private ones excluded)', () => {
    const exported = Object.keys(api).filter((name) => name !== 'getDefaultAudioQueue');
    const publicMethods = classMethods().filter((name) => exported.includes(name));
    expect(exported.length).toBeGreaterThan(50);
    expect(publicMethods.sort()).toEqual(exported.sort());
  });

  test('each function forwards every declared argument and the return value', () => {
    const queue = getDefaultAudioQueue();
    const exported = Object.keys(api).filter((name) => name !== 'getDefaultAudioQueue');
    for (const name of exported) {
      const fn = (api as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
      if (!fn) throw new Error(`missing ${name}`);
      const args = Array.from({ length: fn.length }, (_unused, i) => `arg${i}`);
      const spy = jest
        .spyOn(queue, name as keyof AudioQueue)
        .mockReturnValue(`result:${name}` as never);
      expect(fn(...args)).toBe(`result:${name}`);
      expect(spy).toHaveBeenCalledWith(...args);
      spy.mockRestore();
    }
  });

  test('omitted optional arguments are passed as undefined so AudioQueue defaults apply', () => {
    const spy = jest.spyOn(getDefaultAudioQueue(), 'getQueueLength').mockReturnValue(0);
    api.getQueueLength();
    expect(spy).toHaveBeenCalledWith(undefined);
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
    await api.clearQueueAfterCurrent();
    await api.stopCurrentAudioInChannel();
    await api.stopAllAudioInChannel();
    await api.stopAllAudio();
    await api.destroyChannel(0);
    await api.setGlobalVolume(1);
    expect(api.getQueueLength()).toBe(0);
  });
});
