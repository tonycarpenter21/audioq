/**
 * @fileoverview Tests for createChannelStore: the subscribe/getSnapshot contract used by React's
 * useSyncExternalStore and Svelte stores.
 */
import { createAudioQueue } from '../src/audio-queue';
import type { AudioQueue } from '../src/audio-queue';
import { getDefaultAudioQueue } from '../src/default-queue';
import { createChannelStore } from '../src/store';
import type { ChannelState } from '../src/store';
import { audioAt, flush, installFakeAudio } from './helpers/fake-audio';

let queue: AudioQueue;
const last = <T>(values: readonly T[]): T | undefined => values[values.length - 1];

beforeEach(() => {
  jest.useFakeTimers();
  installFakeAudio();
  queue = createAudioQueue({ logger: null });
});

afterEach(() => jest.useRealTimers());

describe('getSnapshot', () => {
  test('describes an empty channel without creating it', () => {
    const store = createChannelStore(3, queue);
    expect(store.getSnapshot()).toEqual({
      channelNumber: 3,
      current: null,
      isPaused: false,
      items: []
    });
    expect(queue.getAllChannelsInfo()).toEqual([]);
  });

  test('returns the same object until something changes, even without subscribers', async () => {
    const store = createChannelStore(0, queue);
    const empty = store.getSnapshot();
    expect(store.getSnapshot()).toBe(empty);
    await queue.queueAudio('/a.mp3');
    const queued = store.getSnapshot();
    expect(queued).not.toBe(empty);
    expect(queued.items.map((item) => item.fileName)).toEqual(['a.mp3']);
    expect(store.getSnapshot()).toBe(queued);
  });

  test('uses the default queue when none is given', async () => {
    await getDefaultAudioQueue().destroyAllChannels();
    const store = createChannelStore();
    await getDefaultAudioQueue().queueAudio('/default.mp3');
    expect(store.getSnapshot().items[0]?.fileName).toBe('default.mp3');
    await getDefaultAudioQueue().destroyAllChannels();
  });

  test('rejects invalid channels', () => {
    expect(() => createChannelStore(-1, queue)).toThrow(RangeError);
    expect(() => createChannelStore(1.5, queue)).toThrow(RangeError);
    expect(() => createChannelStore(64, queue)).toThrow(RangeError);
  });
});

describe('subscribe', () => {
  test('delivers the current state right away (Svelte store contract)', () => {
    const store = createChannelStore(0, queue);
    const listener = jest.fn();
    store.subscribe(listener);
    expect(listener).toHaveBeenCalledWith(store.getSnapshot());
  });

  test('notifies on queue changes, start, progress, pause and resume', async () => {
    const store = createChannelStore(0, queue);
    const states: ChannelState[] = [];
    store.subscribe((state) => states.push(state));
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/b.mp3');
    await flush();
    expect(last(states)?.current?.fileName).toBe('a.mp3');
    expect(last(states)?.items).toHaveLength(2);

    audioAt(0).tick(2);
    expect(last(states)?.current?.currentTime).toBe(2000);

    await queue.pauseChannel();
    expect(last(states)?.isPaused).toBe(true);
    await queue.resumeChannel();
    expect(last(states)?.isPaused).toBe(false);

    audioAt(0).finish();
    await flush();
    expect(last(states)?.current?.fileName).toBe('b.mp3');
    expect(store.getSnapshot()).toBe(last(states));
  });

  test('does not notify when nothing visible changed', async () => {
    const store = createChannelStore(0, queue);
    await queue.queueAudio('/a.mp3');
    await flush();
    audioAt(0).tick(1);
    const listener = jest.fn();
    store.subscribe(listener);
    listener.mockClear();
    audioAt(0).tick(1); // same position: a progress event, but the same state
    audioAt(0).fire('timeupdate');
    expect(listener).not.toHaveBeenCalled();
  });

  test('stops listening when the last subscriber leaves, and catches up on resubscribe', async () => {
    const store = createChannelStore(0, queue);
    const first = jest.fn();
    const second = jest.fn();
    const offFirst = store.subscribe(first);
    const offSecond = store.subscribe(second);
    offFirst();
    offFirst(); // unsubscribing twice is harmless
    await queue.queueAudio('/a.mp3');
    expect(second.mock.calls[second.mock.calls.length - 1]?.[0]).toMatchObject({
      items: [{ fileName: 'a.mp3' }]
    });
    expect(first).toHaveBeenCalledTimes(1);

    offSecond();
    second.mockClear();
    await queue.queueAudio('/b.mp3');
    expect(second).not.toHaveBeenCalled();

    const third = jest.fn();
    store.subscribe(third);
    expect(third).toHaveBeenCalledTimes(1);
    expect((third.mock.calls[0]?.[0] as ChannelState).items).toHaveLength(2);
  });

  test('only reacts to its own channel', async () => {
    const store = createChannelStore(1, queue);
    const listener = jest.fn();
    store.subscribe(listener);
    listener.mockClear();
    await queue.queueAudio('/other.mp3', 0);
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });
});
