/**
 * @fileoverview Minimal typed event emitter with per-channel filtering and unsubscribe handles.
 */

import type { Unsubscribe } from './types.js';

interface Registration<T> {
  callback: (payload: T) => void;
  channel: number | undefined;
  key: unknown;
}

/**
 * Event emitter keyed by event name, where every listener may be scoped to one channel.
 */
export class Emitter<Events extends object> {
  private readonly listeners: Map<keyof Events, Set<Registration<never>>> = new Map();

  /**
   * @param onListenerError - Called when a listener throws; the error never reaches the emitter
   */
  constructor(
    private readonly onListenerError: (error: unknown) => void,
    private readonly onEmit?: (event: keyof Events, channel: number, payload: unknown) => void
  ) {}

  /**
   * Adds a listener.
   * @param event - Event name
   * @param channel - Only receive events for this channel; `undefined` receives all channels
   * @param callback - Listener
   * @param key - Identity used by `off` to find this listener; defaults to `callback`
   * @returns Function that removes this listener
   */
  on<K extends keyof Events>(
    event: K,
    channel: number | undefined,
    callback: (payload: Events[K]) => void,
    key: unknown = callback
  ): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const registration = { callback, channel, key } as Registration<never>;
    set.add(registration);
    return (): void => {
      set.delete(registration);
    };
  }

  /**
   * Removes listeners for an event on a channel.
   * @param event - Event name
   * @param channel - Channel whose listeners are removed
   * @param key - Remove only the listener registered with this key (its callback by default);
   * omit to remove every listener on the channel
   */
  off(event: keyof Events, channel: number, key?: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const registration of [...set]) {
      if (registration.channel !== channel) continue;
      if (key === undefined || registration.key === key) {
        set.delete(registration);
      }
    }
  }

  /**
   * Removes every listener scoped to a channel, for all events.
   * @param channel - Channel to clear
   */
  clearChannel(channel: number): void {
    for (const set of this.listeners.values()) {
      for (const registration of [...set]) {
        if (registration.channel === channel) set.delete(registration);
      }
    }
  }

  /** Removes every listener. */
  clear(): void {
    this.listeners.clear();
  }

  /**
   * Whether anyone listens to an event on a channel (used to skip building payloads).
   * @param event - Event name
   * @param channel - Channel the event is for
   * @returns True when at least one listener would receive the event
   */
  has(event: keyof Events, channel: number): boolean {
    const set = this.listeners.get(event);
    if (!set) return false;
    for (const registration of set) {
      if (registration.channel === undefined || registration.channel === channel) return true;
    }
    return false;
  }

  /**
   * Calls every matching listener. A throwing listener does not stop the others.
   * @param event - Event name
   * @param channel - Channel the event is for
   * @param payload - Value passed to listeners
   */
  emit<K extends keyof Events>(event: K, channel: number, payload: Events[K]): void {
    this.onEmit?.(event, channel, payload);
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const registration of [...set] as Registration<Events[K]>[]) {
      if (registration.channel !== undefined && registration.channel !== channel) continue;
      try {
        registration.callback(payload);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }
}
