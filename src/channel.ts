/**
 * @fileoverview Internal channel and item state. Output volume is the product of independent
 * factors (channel, item, global, ducking, fade), so no feature overwrites another's volume.
 */

import type { Disposer } from './media.js';
import type { Tween } from './tween.js';
import type { GainRoute } from './web-audio.js';
import type { FadeType, ItemOutcome, QueueItem } from './types.js';
import { extractFileName, secondsToMs } from './utils.js';

/** One queued audio file. */
export interface Item {
  /** Set while the browser refuses playback until a user gesture. */
  blocked: boolean;
  /** Channel number. */
  readonly channelNumber: number;
  /** CORS mode for the element. */
  readonly crossOrigin: 'anonymous' | 'use-credentials' | undefined;
  /** Listener removers for the element. */
  disposers: Disposer[];
  /** The element; created when the item enters the prefetch window. */
  element: HTMLAudioElement | undefined;
  /** Unique id. */
  readonly id: number;
  /** Timer that skips the item if it does not start in time. */
  loadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the item loops. */
  readonly loop: boolean;
  /** Whether play() has been requested since the item became current or was last paused. */
  playRequested: boolean;
  /** Settles the `finished` promise. */
  readonly resolveFinished: (outcome: ItemOutcome) => void;
  /** Settles the `started` promise. */
  readonly resolveStarted: (started: boolean) => void;
  /** Web Audio gain routing, when used. */
  route: GainRoute | undefined;
  /** Whether the item has left the queue and released its resources. */
  settled: boolean;
  /** Resolved URL. */
  readonly src: string;
  /** Whether the `playing` event has fired at least once. */
  started: boolean;
  /** Item volume multiplier (0-1). */
  readonly volume: number;
}

/** Fade preset remembered by `pauseWithFade` for the matching `resumeWithFade`. */
export interface RememberedFade {
  /** Custom duration, if one was passed. */
  duration: number | undefined;
  /** Preset name. */
  fadeType: FadeType;
}

/** State of one channel. */
export class Channel {
  /** Ducking multiplier (1 when not ducked). */
  duckFactor: number = 1;
  /** Target the current ducking transition is heading to. */
  duckTarget: number = 1;
  /** Running ducking transition. */
  duckTween: Tween | undefined;
  /** Pause/resume fade multiplier (1 when not fading). */
  fadeFactor: number = 1;
  /** Running pause/resume fade. */
  fadeTween: Tween | undefined;
  /** Items in play order; index 0 is current. */
  readonly items: Item[] = [];
  /** Fade used by the last `pauseWithFade`. */
  lastFade: RememberedFade | undefined;
  /** Channel-specific queue limit. */
  maxQueueSize: number | undefined;
  /** Whether the channel is paused. */
  paused: boolean = false;
  /** Channel volume (0-1). */
  volume: number = 1;
  /** Running channel volume transition. */
  volumeTween: Tween | undefined;

  /**
   * @param channelNumber - The channel's number
   */
  constructor(readonly channelNumber: number) {}

  /**
   * The item at the front of the queue.
   * @returns The current item, or undefined when the queue is empty
   */
  get head(): Item | undefined {
    return this.items[0];
  }

  /**
   * Output gain for the current item.
   * @param globalVolume - Global volume multiplier
   * @returns Product of all volume factors, clamped to 0-1
   */
  effectiveGain(globalVolume: number): number {
    const itemVolume = this.head?.volume ?? 1;
    const gain = this.volume * itemVolume * globalVolume * this.duckFactor * this.fadeFactor;
    return Math.min(1, Math.max(0, gain));
  }

  /** Cancels every running transition on this channel. */
  cancelTweens(): void {
    this.volumeTween?.cancel();
    this.duckTween?.cancel();
    this.fadeTween?.cancel();
    this.volumeTween = undefined;
    this.duckTween = undefined;
    this.fadeTween = undefined;
  }

  /**
   * Describes the items for a snapshot.
   * @returns One entry per item
   */
  describeItems(): QueueItem[] {
    return this.items.map((item, index) => ({
      duration: item.element ? secondsToMs(item.element.duration) : 0,
      fileName: extractFileName(item.src),
      id: item.id,
      isCurrentlyPlaying:
        index === 0 && !this.paused && item.element !== undefined && !item.element.paused,
      isLooping: item.loop,
      src: item.src,
      volume: item.volume
    }));
  }
}
