/**
 * @fileoverview A channel's state as a subscribable store, for UI frameworks: React
 * (`useSyncExternalStore`), Svelte (it is a Svelte store), Vue, Solid, or plain code.
 */

import type { AudioQueue } from './audio-queue.js';
import { getDefaultAudioQueue } from './default-queue.js';
import type { AudioInfo, QueueItem, Unsubscribe } from './types.js';
import { assertChannelNumber } from './utils.js';

/** A channel's state, as delivered by a {@link ChannelStore}. */
export interface ChannelState {
  /** The channel. */
  readonly channelNumber: number;
  /** The current item, or `null` when the channel is empty. */
  readonly current: AudioInfo | null;
  /** Whether the channel is paused. */
  readonly isPaused: boolean;
  /** Every item in play order; index 0 is the current one. */
  readonly items: readonly QueueItem[];
}

/** Listener of a {@link ChannelStore}. */
export type ChannelStateListener = (state: ChannelState) => void;

/** A channel's state that UI code can subscribe to. Create one per channel, outside render. */
export interface ChannelStore {
  /**
   * The current state. It is the same object until something changes, as React's
   * `useSyncExternalStore` requires.
   */
  getSnapshot: () => ChannelState;
  /**
   * Calls `listener` with the current state right away, then on every change (Svelte's store
   * contract; React ignores the argument).
   */
  subscribe: (listener: ChannelStateListener) => Unsubscribe;
}

/** Events after which a channel's state may have changed. */
const EVENTS = [
  'onAudioComplete',
  'onAudioError',
  'onAudioPause',
  'onAudioProgress',
  'onAudioResume',
  'onAudioStart',
  'onQueueChange'
] as const;

const read = (queue: AudioQueue, channelNumber: number): ChannelState => ({
  channelNumber,
  current: queue.getCurrentAudioInfo(channelNumber),
  isPaused: queue.isChannelPaused(channelNumber),
  items: queue.getQueueSnapshot(channelNumber)?.items ?? []
});

/** The parts of a state a UI shows, as one comparable string. */
const fingerprint = ({ current, isPaused, items }: ChannelState): string =>
  [
    isPaused,
    current &&
      [
        current.id,
        current.currentTime,
        current.duration,
        current.isLoading,
        current.isPaused,
        current.isPlaying,
        current.playbackRate,
        current.volume
      ].join(),
    ...items.map((item) => [item.id, item.duration, item.isCurrentlyPlaying, item.volume].join())
  ].join('|');

/**
 * Makes a store for one channel's state. It listens to the queue only while it has subscribers,
 * and delivers a new state object only when something visible changed (position, item, pause
 * state, queue order, volume, speed). `destroyAllChannels()` removes its listeners too:
 * subscribe again afterwards.
 * @param channelNumber - Channel (defaults to 0)
 * @param queue - Queue to read (defaults to the default queue)
 * @returns The store
 * @example
 * ```tsx
 * const music = createChannelStore(0);
 * // React
 * const state = useSyncExternalStore(music.subscribe, music.getSnapshot);
 * // Svelte: {$music.current?.fileName}
 * ```
 */
export const createChannelStore = (channelNumber: number = 0, queue?: AudioQueue): ChannelStore => {
  const source = (): AudioQueue => queue ?? getDefaultAudioQueue();
  assertChannelNumber(channelNumber, source().getQueueConfig().maxChannels);
  const listeners: Set<ChannelStateListener> = new Set();
  let state = read(source(), channelNumber);
  let key = fingerprint(state);
  let detach: Unsubscribe[] = [];

  /** Re-reads the state; replaces it only when it changed. */
  const refresh = (): boolean => {
    const next = read(source(), channelNumber);
    const nextKey = fingerprint(next);
    if (nextKey === key) return false;
    state = next;
    key = nextKey;
    return true;
  };

  const notify = (): void => {
    if (refresh()) listeners.forEach((listener) => listener(state));
  };

  return {
    getSnapshot: (): ChannelState => {
      // While unsubscribed nothing keeps the state current, so check now.
      if (listeners.size === 0) refresh();
      return state;
    },
    subscribe: (listener: ChannelStateListener): Unsubscribe => {
      if (listeners.size === 0) {
        refresh();
        const target = source();
        detach = EVENTS.map((event) => target[event](channelNumber, notify));
      }
      listeners.add(listener);
      listener(state);
      return (): void => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        detach.forEach((unsubscribe) => unsubscribe());
        detach = [];
      };
    }
  };
};
