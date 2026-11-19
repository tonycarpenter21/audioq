/**
 * @fileoverview Internal channel and item state. Output volume is the product of independent
 * factors (channel, item, global, ducking, fade), so no feature overwrites another's volume.
 */

import type { Disposer } from './media.js';
import type { Tween } from './tween.js';
import type { GainRoute } from './web-audio.js';
import type {
  AudioCue,
  AudioMetadata,
  FadeType,
  HistoryEntry,
  ItemOutcome,
  QueueItem,
  RepeatMode
} from './types.js';
import { secondsToMs } from './utils.js';

/** One queued audio file. */
export interface Item {
  /** Indexes of ranged cues the playback position is currently inside. */
  readonly activeCues: Set<number>;
  /** Set while the browser refuses playback until a user gesture. */
  blocked: boolean;
  /** Channel number. */
  readonly channelNumber: number;
  /** CORS mode for the element. */
  readonly crossOrigin: 'anonymous' | 'use-credentials' | undefined;
  /** Cues sorted by start time. */
  readonly cues: readonly AudioCue[];
  /** Position (ms) where playback ends early, for segments and sprites. */
  readonly endAt: number | undefined;
  /** Listener removers for the element. */
  disposers: Disposer[];
  /** The element; created when the item enters the prefetch window. */
  element: HTMLAudioElement | undefined;
  /** Readable name: the File name for File sources, otherwise taken from the URL. */
  readonly fileName: string;
  /** Unique id. */
  readonly id: number;
  /** Position (ms) at the previous cue check, to detect point cues being passed. */
  lastCueMs: number;
  /** Timer that skips the item if it does not start in time. */
  loadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the item loops. */
  readonly loop: boolean;
  /** Metadata given when the item was queued. */
  readonly metadata: AudioMetadata | undefined;
  /** Object URL created for a Blob source; revoked when the item is released. */
  objectUrl: string | undefined;
  /** Item playback speed (multiplied with the channel rate). */
  readonly playbackRate: number;
  /** Timer that wakes the position tracker at the next cue, segment end or crossfade. */
  positionTimer: ReturnType<typeof setTimeout> | undefined;
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
  /** Start of the segment (ms); repeats and segment loops return here. */
  readonly segmentStart: number;
  /** Position (ms) to start from when the item first plays. */
  startAt: number;
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
  /** Muted with setChannelMuted: silent, with the volume kept for unmuting. */
  muted: boolean = false;
  /** Target the current ducking transition is heading to. */
  duckTarget: number = 1;
  /** Running ducking transition. */
  duckTween: Tween | undefined;
  /** Overlap between items in milliseconds (0 for none). */
  crossfadeMs: number = 0;
  /** The previous item while it fades out during a crossfade. */
  outgoing: Item | undefined;
  /** The fade-out of the outgoing item. */
  outgoingTween: Tween | undefined;
  /** Pause/resume fade multiplier (1 when not fading). */
  fadeFactor: number = 1;
  /** Running pause/resume fade. */
  fadeTween: Tween | undefined;
  /** Items in play order; index 0 is current. */
  readonly items: Item[] = [];
  /** Pause between items in milliseconds. */
  gapMs: number = 0;
  /** Timer delaying the next item by `gapMs`. */
  gapTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the channel was paused because the page became hidden. */
  hiddenPause: boolean = false;
  /** Finished items, oldest first. */
  readonly history: HistoryEntry[] = [];
  /** Fade used by the last `pauseWithFade`. */
  lastFade: RememberedFade | undefined;
  /** Channel-specific queue limit. */
  maxQueueSize: number | undefined;
  /** Whether the channel is paused. */
  paused: boolean = false;
  /** A pauseWithFade is fading out; the channel pauses when it finishes. */
  /** Stereo position (-1 left to 1 right); needs Web Audio routing. */
  pan: number = 0;
  pendingPause: boolean = false;
  /** Channel playback speed (multiplied with each item's rate). */
  playbackRate: number = 1;
  /** Sources recently queued, with the time until which repeats are ignored (`dedupeMs`). */
  readonly recentSources: Map<string, number> = new Map();
  /** What happens when an item ends. */
  repeat: RepeatMode = 'off';
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
   * @returns Product of all volume factors, clamped to 0-1 (0 while the channel is muted)
   */
  effectiveGain(globalVolume: number): number {
    const itemVolume = this.head?.volume ?? 1;
    if (this.muted) return 0;
    const gain = this.volume * itemVolume * globalVolume * this.duckFactor * this.fadeFactor;
    return Math.min(1, Math.max(0, gain));
  }

  /**
   * Effective playback speed for the current item.
   * @returns Item rate × channel rate
   */
  effectiveRate(): number {
    return (this.head?.playbackRate ?? 1) * this.playbackRate;
  }

  /** Cancels the gap timer between items. */
  clearGap(): void {
    if (this.gapTimer !== undefined) clearTimeout(this.gapTimer);
    this.gapTimer = undefined;
  }

  /**
   * Records a finished item, keeping at most `limit` entries.
   * @param entry - The finished item
   * @param limit - Maximum history length (0 keeps nothing)
   */
  remember(entry: HistoryEntry, limit: number): void {
    if (limit <= 0) return;
    this.history.push(entry);
    if (this.history.length > limit) this.history.splice(0, this.history.length - limit);
  }

  /**
   * Whether `src` was queued within its dedupe window; records it for `windowMs` otherwise.
   * @param src - Source URL
   * @param windowMs - Dedupe window in milliseconds
   * @param now - Current time (`Date.now()`)
   * @returns True when this is a repeat that should be skipped
   */
  isDuplicate(src: string, windowMs: number, now: number): boolean {
    for (const [source, until] of this.recentSources) {
      if (until <= now) this.recentSources.delete(source);
    }
    if ((this.recentSources.get(src) ?? 0) > now) return true;
    this.recentSources.set(src, now + windowMs);
    return false;
  }

  /** Cancels every running transition on this channel. */
  cancelTweens(): void {
    this.volumeTween?.cancel();
    this.duckTween?.cancel();
    this.fadeTween?.cancel();
    this.outgoingTween?.cancel();
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
      fileName: item.fileName,
      id: item.id,
      isCurrentlyPlaying:
        index === 0 && !this.paused && item.element !== undefined && !item.element.paused,
      isLooping: item.loop,
      metadata: item.metadata,
      playbackRate: item.playbackRate,
      src: item.src,
      volume: item.volume
    }));
  }
}
