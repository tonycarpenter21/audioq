/**
 * @fileoverview QueueEngine: the internal playback engine behind AudioQueue (channels, item
 * lifecycle, gain, ducking, autoplay unlock). AudioQueue extends it with the public API.
 *
 * Design rules that keep it correct:
 * - Every queue mutation is synchronous, so no locks are needed.
 * - Every async callback (play() results, element events, timers) first checks that its item is
 *   still the current item and not yet released, so stale callbacks can never act.
 * - Items release their element, listeners, timers and Web Audio nodes exactly once (`finalize`).
 */

import { Channel } from './channel.js';
import type { Item } from './channel.js';
import {
  DEFAULT_DUCK_TRANSITION_MS,
  clampPlaybackRate,
  defaultQueueConfig,
  getFadeConfig,
  mergeQueueConfig
} from './config.js';
import { Emitter } from './emitter.js';
import {
  categorizeMediaError,
  categorizePlayError,
  isSameOriginSource,
  listen,
  releaseElement,
  resolveUrl,
  toError
} from './media.js';
import { startTween } from './tween.js';
import type { Tween } from './tween.js';
import {
  AudioErrorType,
  EasingType,
  FadeType,
  type AudioCompleteInfo,
  type AudioErrorInfo,
  type AudioInfo,
  type AudioQueueOptions,
  type AudioSource,
  type AudioStartInfo,
  type CompletionReason,
  type ItemOutcome,
  type QueueConfig,
  type QueueManipulationResult,
  type QueueSnapshot,
  type QueuedAudio,
  type Unsubscribe,
  type VolumeConfig
} from './types.js';
import { assertChannelNumber, clampUnit, extractFileName, secondsToMs } from './utils.js';
import { WebAudioEngine, shouldUseWebAudio } from './web-audio.js';

/** Events emitted by a queue, with their payloads. */
export interface QueueEvents {
  complete: AudioCompleteInfo;
  error: AudioErrorInfo;
  pause: AudioInfo;
  progress: AudioInfo;
  queuechange: QueueSnapshot;
  resume: AudioInfo;
  start: AudioStartInfo;
}

const UNLOCK_EVENTS: readonly string[] = ['pointerdown', 'keydown', 'touchend'];
const PROGRESS_EVENTS: readonly string[] = ['timeupdate', 'loadedmetadata', 'pause'];

/**
 * Internal state and playback machinery shared by every AudioQueue. Not part of the public API.
 */
export class QueueEngine {
  protected readonly channels: Map<number, Channel> = new Map();
  protected config: QueueConfig;
  protected ducking: VolumeConfig | undefined;
  protected readonly emitter: Emitter<QueueEvents>;
  protected globalVolume: number = 1;
  protected nextId: number = 1;
  protected unlockArmed: boolean = false;
  protected visibilityArmed: boolean = false;
  protected readonly webAudio: WebAudioEngine = new WebAudioEngine();

  /**
   * @param config - Configuration overrides; see {@link QueueConfig}
   */
  constructor(config: Partial<QueueConfig> = {}) {
    this.config = mergeQueueConfig(defaultQueueConfig(), config);
    this.emitter = new Emitter<QueueEvents>((error) =>
      this.config.logger?.error('audioq: error in event listener', error)
    );
    this.syncVisibilityListener();
  }

  protected subscribe<K extends keyof QueueEvents>(
    event: K,
    channelNumber: number,
    callback: (payload: QueueEvents[K]) => void
  ): Unsubscribe {
    assertChannelNumber(channelNumber, this.config.maxChannels);
    return this.emitter.on(event, channelNumber, callback);
  }

  protected channel(channelNumber: number): Channel {
    assertChannelNumber(channelNumber, this.config.maxChannels);
    let channel = this.channels.get(channelNumber);
    if (!channel) {
      channel = new Channel(channelNumber);
      channel.duckFactor = this.duckTargetFor(channelNumber);
      channel.duckTarget = channel.duckFactor;
      this.channels.set(channelNumber, channel);
    }
    return channel;
  }

  protected existing(channelNumber: number): Channel | undefined {
    return this.channels.get(channelNumber);
  }

  protected perChannel<T>(read: (channel: Channel | undefined) => T): T[] {
    const highest = Math.max(-1, ...this.channels.keys());
    return Array.from({ length: highest + 1 }, (_unused, n) => read(this.channels.get(n)));
  }

  protected makeRoom(channel: Channel, override: number | undefined): void {
    const limit = override ?? channel.maxQueueSize ?? this.config.defaultMaxQueueSize;
    if (limit === undefined || channel.items.length < limit) return;
    if (this.config.showQueueWarnings) {
      this.config.logger?.warn(
        `audioq: queue limit ${limit} reached on channel ${channel.channelNumber}`
      );
    }
    if (this.config.dropOldestWhenFull && channel.items.length > 1) {
      const [dropped] = channel.items.splice(1, 1);
      if (dropped) this.finalize(dropped, 'removed');
      return;
    }
    throw new Error(`Queue size limit exceeded for channel ${channel.channelNumber}`);
  }

  protected createItem(
    source: AudioSource,
    channelNumber: number,
    options: AudioQueueOptions
  ): { handle: QueuedAudio; item: Item } {
    const isBlob = typeof Blob !== 'undefined' && source instanceof Blob;
    const objectUrl = isBlob ? URL.createObjectURL(source) : undefined;
    const src = objectUrl ?? resolveUrl(String(source));
    const blobName = isBlob ? (source as Blob & { name?: unknown }).name : undefined;
    const fileName =
      typeof blobName === 'string' && blobName.length > 0
        ? blobName
        : isBlob
          ? (options.metadata?.title ?? 'audio')
          : extractFileName(src);
    return this.buildItem(channelNumber, {
      crossOrigin: options.crossOrigin,
      fileName,
      loop: options.loop === true,
      metadata: options.metadata,
      objectUrl,
      playbackRate: clampPlaybackRate(options.playbackRate),
      src,
      startAt: Number.isFinite(options.startAt) ? Math.max(0, options.startAt as number) : 0,
      volume: clampUnit(options.volume ?? 1)
    });
  }

  /** Creates an item plus its public handle from already-normalized settings. */
  protected buildItem(
    channelNumber: number,
    settings: Pick<
      Item,
      | 'crossOrigin'
      | 'fileName'
      | 'loop'
      | 'metadata'
      | 'objectUrl'
      | 'playbackRate'
      | 'src'
      | 'startAt'
      | 'volume'
    >
  ): { handle: QueuedAudio; item: Item } {
    let resolveStarted: (started: boolean) => void = () => undefined;
    let resolveFinished: (outcome: ItemOutcome) => void = () => undefined;
    const started = new Promise<boolean>((resolve) => (resolveStarted = resolve));
    const finished = new Promise<ItemOutcome>((resolve) => (resolveFinished = resolve));
    const item: Item = {
      ...settings,
      blocked: false,
      channelNumber,
      disposers: [],
      element: undefined,
      id: this.nextId++,
      loadTimer: undefined,
      playRequested: false,
      resolveFinished,
      resolveStarted,
      route: undefined,
      settled: false,
      started: false
    };
    const handle: QueuedAudio = {
      channelNumber,
      finished,
      id: item.id,
      metadata: item.metadata,
      src: item.src,
      started
    };
    return { handle, item };
  }

  /** A handle for a call that was ignored (dedupe): it never plays. */
  protected skippedHandle(
    channelNumber: number,
    src: string,
    options: AudioQueueOptions
  ): QueuedAudio {
    return {
      channelNumber,
      finished: Promise.resolve('skipped'),
      id: this.nextId++,
      metadata: options.metadata,
      src,
      started: Promise.resolve(false)
    };
  }

  /** Makes sure the current item is playing (unless paused) and upcoming items are preloaded. */
  protected refresh(channel: Channel): void {
    const upcoming = channel.items.slice(0, this.config.prefetchCount + 1);
    upcoming.forEach((item) => this.ensureElement(channel, item));
    const head = channel.head;
    const waiting = channel.gapTimer !== undefined;
    if (head && !channel.paused && !head.playRequested && !head.blocked && !waiting) {
      void this.play(channel, head);
    }
    this.updateDucking();
  }

  protected ensureElement(channel: Channel, item: Item): HTMLAudioElement {
    if (item.element) return item.element;
    const element = new Audio();
    element.preload = 'auto';
    element.loop = item.loop;
    element.preservesPitch = true;
    if (item.crossOrigin !== undefined) element.crossOrigin = item.crossOrigin;
    element.src = item.src;
    item.element = element;
    const whenHead =
      (action: () => void): (() => void) =>
      (): void => {
        if (channel.head === item && !item.settled) action();
      };
    item.disposers.push(
      listen(
        element,
        'playing',
        whenHead(() => this.onPlaying(channel, item))
      ),
      listen(
        element,
        'ended',
        whenHead(() => this.onEnded(channel, item))
      ),
      listen(
        element,
        'pause',
        whenHead(() => this.onElementPause(channel, item, element))
      ),
      listen(
        element,
        'play',
        whenHead(() => this.onElementPlay(channel, item))
      ),
      listen(element, 'loadedmetadata', () => this.applyStartAt(item, element)),
      listen(element, 'error', () => {
        if (!item.settled) this.onElementError(channel, item);
      }),
      ...PROGRESS_EVENTS.map((type) =>
        listen(
          element,
          type,
          whenHead(() => this.emitProgress(channel, item))
        )
      )
    );
    this.routeThroughWebAudio(channel, item, element);
    return element;
  }

  protected routeThroughWebAudio(channel: Channel, item: Item, element: HTMLAudioElement): void {
    if (!shouldUseWebAudio(this.config.webAudio)) return;
    const pageOrigin = typeof location === 'undefined' ? undefined : location.origin;
    // Cross-origin media without CORS plays as silence through Web Audio, so only route sources
    // that are same-origin or explicitly loaded with CORS.
    if (item.crossOrigin === undefined && !isSameOriginSource(item.src, pageOrigin)) return;
    item.route = this.webAudio.connect(element, channel.effectiveGain(this.globalVolume));
  }

  protected play(channel: Channel, item: Item): Promise<void> {
    const element = this.ensureElement(channel, item);
    item.playRequested = true;
    this.applyGain(channel);
    this.applyRate(channel);
    this.applyStartAt(item, element);
    this.startLoadTimer(channel, item);
    let attempt: Promise<void>;
    try {
      attempt = Promise.resolve(element.play());
    } catch (error) {
      attempt = Promise.reject(error);
    }
    return attempt.then(
      () => undefined,
      (error: unknown) => this.onPlayRejected(channel, item, error)
    );
  }

  protected onPlaying(channel: Channel, item: Item): void {
    item.blocked = false;
    this.clearLoadTimer(item);
    if (item.started) return;
    item.started = true;
    item.resolveStarted(true);
    this.emitter.emit('start', channel.channelNumber, {
      channelNumber: channel.channelNumber,
      duration: secondsToMs(item.element?.duration ?? NaN),
      fileName: item.fileName,
      id: item.id,
      metadata: item.metadata,
      src: item.src
    });
  }

  protected onPlayRejected(channel: Channel, item: Item, error: unknown): void {
    if (channel.head !== item || item.settled || channel.paused) return;
    const type = categorizePlayError(error);
    if (type === null) return; // play() was interrupted by pause() or a source change
    if (type === AudioErrorType.AutoplayBlocked) {
      this.clearLoadTimer(item);
      if (!item.blocked) {
        item.blocked = true;
        this.emitError(channel, item, type, toError(error, 'Autoplay was blocked'), 0);
      }
      this.armUnlock();
      return;
    }
    this.fail(channel, item, type, toError(error, 'Playback failed'));
  }

  protected onElementError(channel: Channel, item: Item): void {
    const mediaError = item.element?.error;
    const type = categorizeMediaError(mediaError);
    const error = new Error(mediaError?.message || `Media error (${type})`);
    if (channel.head === item) {
      this.fail(channel, item, type, error);
      return;
    }
    // A waiting item failed while preloading: drop it now so it never interrupts playback.
    const index = channel.items.indexOf(item);
    if (index > 0) channel.items.splice(index, 1);
    this.emitError(channel, item, type, error, channel.items.length - 1);
    this.finalize(item, 'error');
    this.emitQueueChange(channel);
    this.refresh(channel);
  }

  protected fail(channel: Channel, item: Item, type: AudioErrorType, error: Error): void {
    this.emitError(channel, item, type, error, channel.items.length - 1);
    this.advance(channel, 'error');
  }

  /** Removes the current item and moves on to the next one. */
  protected advance(channel: Channel, reason: CompletionReason): void {
    const head = channel.items.shift();
    if (!head) return;
    channel.paused = false;
    this.resetFade(channel);
    this.retire(channel, head, reason, channel.items.length);
    this.emitQueueChange(channel);
    this.startGap(channel);
    this.refresh(channel);
  }

  /** Reports a finished item (complete event and history), then releases it. */
  protected retire(
    channel: Channel,
    item: Item,
    reason: CompletionReason,
    remainingInQueue: number
  ): void {
    this.report(channel, item, reason, remainingInQueue);
    this.finalize(item, reason);
  }

  /** Emits the complete event for an item and records it in the channel history. */
  protected report(
    channel: Channel,
    item: Item,
    reason: CompletionReason,
    remainingInQueue: number
  ): void {
    const entry = {
      channelNumber: channel.channelNumber,
      fileName: item.fileName,
      id: item.id,
      metadata: item.metadata,
      playedMs: secondsToMs(item.element?.currentTime ?? 0),
      reason,
      src: item.src
    };
    this.emitter.emit('complete', channel.channelNumber, { ...entry, remainingInQueue });
    channel.remember({ ...entry, finishedAt: Date.now() }, this.config.historySize);
  }

  /** Removes every item from a channel: the current one is reported as stopped. */
  protected clearChannel(channel: Channel): void {
    const removed = channel.items.splice(0, channel.items.length);
    channel.paused = false;
    channel.hiddenPause = false;
    channel.clearGap();
    this.resetFade(channel);
    const [head, ...rest] = removed;
    if (head) this.retire(channel, head, 'stopped', 0);
    rest.forEach((item) => this.finalize(item, 'removed'));
    if (removed.length > 0) this.emitQueueChange(channel);
    this.updateDucking();
  }

  /** An item reached its end: repeat it, re-queue it, or move on. */
  protected onEnded(channel: Channel, item: Item): void {
    if (channel.repeat === 'one') {
      this.retireForRepeat(channel, item);
      return;
    }
    if (channel.repeat === 'all') channel.items.push(this.copyForRepeat(item));
    this.advance(channel, 'ended');
  }

  /** Repeat-one: report the play-through, then play the same item again from the start. */
  protected retireForRepeat(channel: Channel, item: Item): void {
    this.report(channel, item, 'ended', channel.items.length - 1);
    item.started = false;
    item.playRequested = false;
    item.startAt = 0;
    if (item.element) item.element.currentTime = 0;
    this.startGap(channel);
    this.refresh(channel);
  }

  /** Repeat-all: a fresh copy of a finished item for the end of the queue. */
  protected copyForRepeat(item: Item): Item {
    const { item: copy } = this.buildItem(item.channelNumber, {
      crossOrigin: item.crossOrigin,
      fileName: item.fileName,
      loop: item.loop,
      metadata: item.metadata,
      objectUrl: item.objectUrl,
      playbackRate: item.playbackRate,
      src: item.src,
      startAt: 0,
      volume: item.volume
    });
    // The copy now owns the Blob's object URL, so releasing the original must not revoke it.
    item.objectUrl = undefined;
    return copy;
  }

  /** Waits `gapMs` before the next item starts. */
  protected startGap(channel: Channel): void {
    channel.clearGap();
    if (channel.gapMs <= 0 || channel.items.length === 0) return;
    channel.gapTimer = setTimeout(() => {
      channel.gapTimer = undefined;
      this.refresh(channel);
    }, channel.gapMs);
  }

  /** Releases everything an item holds. Safe to call more than once. */
  protected finalize(item: Item, outcome: ItemOutcome): void {
    if (item.settled) return;
    item.settled = true;
    item.blocked = false;
    this.clearLoadTimer(item);
    item.disposers.forEach((dispose) => dispose());
    item.disposers = [];
    if (item.route) this.webAudio.disconnect(item.route);
    item.route = undefined;
    if (item.element) releaseElement(item.element);
    item.element = undefined;
    if (item.objectUrl !== undefined) URL.revokeObjectURL(item.objectUrl);
    item.objectUrl = undefined;
    if (!item.started) item.resolveStarted(false);
    item.resolveFinished(outcome);
    if (!this.hasBlockedItems()) this.disarmUnlock();
  }

  protected startLoadTimer(channel: Channel, item: Item): void {
    this.clearLoadTimer(item);
    if (item.started || this.config.loadTimeoutMs <= 0) return;
    item.loadTimer = setTimeout(() => {
      item.loadTimer = undefined;
      if (channel.head !== item || item.settled || item.started || item.blocked) return;
      if (channel.paused) return;
      const error = new Error(`Audio did not start within ${this.config.loadTimeoutMs}ms`);
      this.fail(channel, item, AudioErrorType.Timeout, error);
    }, this.config.loadTimeoutMs);
  }

  protected clearLoadTimer(item: Item): void {
    if (item.loadTimer !== undefined) clearTimeout(item.loadTimer);
    item.loadTimer = undefined;
  }

  protected fade(
    channel: Channel,
    to: number,
    duration: number,
    easing: EasingType
  ): Promise<boolean> {
    channel.fadeTween?.cancel();
    const tween: Tween = startTween({
      duration,
      easing,
      from: channel.fadeFactor,
      onUpdate: (value) => {
        channel.fadeFactor = value;
        this.applyGain(channel);
      },
      to
    });
    channel.fadeTween = tween;
    return tween.done.then((completed) => {
      if (channel.fadeTween === tween) channel.fadeTween = undefined;
      return completed;
    });
  }

  /** Resume settings: explicit arguments win, then the pause fade's, then the Gentle preset. */
  protected resumeFadeSettings(
    channel: Channel,
    fadeType: FadeType | undefined,
    duration: number | undefined
  ): { curve: EasingType; length: number } {
    const preset = getFadeConfig(fadeType ?? channel.lastFade?.fadeType ?? FadeType.Gentle);
    return {
      curve: preset.resumeCurve,
      length: duration ?? channel.lastFade?.duration ?? preset.duration
    };
  }

  protected resetFade(channel: Channel): void {
    channel.fadeTween?.cancel();
    channel.fadeTween = undefined;
    channel.fadeFactor = 1;
    this.applyGain(channel);
  }

  protected duckTargetFor(channelNumber: number): number {
    const ducking = this.ducking;
    if (!ducking) return 1;
    const priority = this.channels.get(ducking.priorityChannel);
    if (!priority || priority.items.length === 0) return 1;
    return channelNumber === ducking.priorityChannel
      ? ducking.priorityVolume
      : ducking.duckingVolume;
  }

  protected updateDucking(): void {
    const ducking = this.ducking;
    this.channels.forEach((channel) => {
      const target = this.duckTargetFor(channel.channelNumber);
      if (target === channel.duckTarget) return;
      const restoring = target > channel.duckTarget;
      channel.duckTarget = target;
      channel.duckTween?.cancel();
      const duration = restoring
        ? (ducking?.restoreTransitionDuration ?? DEFAULT_DUCK_TRANSITION_MS)
        : (ducking?.duckTransitionDuration ?? DEFAULT_DUCK_TRANSITION_MS);
      channel.duckTween = startTween({
        duration,
        easing: ducking?.transitionEasing ?? EasingType.EaseOut,
        from: channel.duckFactor,
        onUpdate: (value) => {
          channel.duckFactor = value;
          this.applyGain(channel);
        },
        to: target
      });
    });
  }

  protected applyGain(channel: Channel): void {
    const head = channel.head;
    if (!head?.element) return;
    const gain = channel.effectiveGain(this.globalVolume);
    if (head.route) {
      this.webAudio.setGain(head.route, gain);
    } else {
      head.element.volume = gain;
    }
  }

  protected applyRate(channel: Channel): void {
    const element = channel.head?.element;
    if (element) element.playbackRate = channel.effectiveRate();
  }

  /** Jumps to `startAt` once, before the item has played. */
  protected applyStartAt(item: Item, element: HTMLAudioElement): void {
    if (item.started || item.startAt <= 0) return;
    try {
      element.currentTime = item.startAt / 1000;
    } catch {
      // Not seekable yet; retried on loadedmetadata.
    }
  }

  /** The browser or OS paused playback (phone call, headphones unplugged, media controls). */
  protected onElementPause(channel: Channel, item: Item, element: HTMLAudioElement): void {
    // Our own pauses set channel.paused first; the pause fired right before `ended` is not one.
    if (channel.paused || element.ended || !item.started) return;
    channel.paused = true;
    item.playRequested = false;
    this.clearLoadTimer(item);
    this.emitter.emit('pause', channel.channelNumber, this.describeHead(channel, item));
  }

  /** The browser or OS resumed playback (for example from lock-screen controls). */
  protected onElementPlay(channel: Channel, item: Item): void {
    if (!channel.paused) return;
    channel.paused = false;
    channel.hiddenPause = false;
    item.playRequested = true;
    this.resetFade(channel);
    this.emitter.emit('resume', channel.channelNumber, this.describeHead(channel, item));
  }

  /** Pauses a channel now (shared by pauseChannel, fades and pauseWhenHidden). */
  protected pauseNow(channel: Channel): void {
    const head = channel.head;
    if (!head || channel.paused) return;
    channel.fadeTween?.cancel();
    channel.paused = true;
    head.playRequested = false;
    this.clearLoadTimer(head);
    head.element?.pause();
    this.emitter.emit('pause', channel.channelNumber, this.describeHead(channel, head));
  }

  /** Resumes a paused channel; resolves once the browser accepted or refused playback. */
  protected async resumeNow(channel: Channel): Promise<void> {
    const head = channel.head;
    if (!head || !channel.paused) return;
    this.resetFade(channel);
    channel.paused = false;
    channel.hiddenPause = false;
    const attempt = channel.gapTimer === undefined ? this.play(channel, head) : undefined;
    this.emitter.emit('resume', channel.channelNumber, this.describeHead(channel, head));
    await attempt;
  }

  protected readonly onVisibilityChange = (): void => {
    if (typeof document === 'undefined') return;
    this.channels.forEach((channel) => {
      if (document.hidden) {
        if (!channel.head || channel.paused) return;
        this.pauseNow(channel);
        channel.hiddenPause = true;
      } else if (channel.hiddenPause) {
        void this.resumeNow(channel);
      }
    });
  };

  /** Adds or removes the visibilitychange listener to match `pauseWhenHidden`. */
  protected syncVisibilityListener(): void {
    if (typeof document === 'undefined') return;
    const wanted = this.config.pauseWhenHidden;
    if (wanted === this.visibilityArmed) return;
    this.visibilityArmed = wanted;
    if (wanted) document.addEventListener('visibilitychange', this.onVisibilityChange);
    else document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  protected anyPlaying(): boolean {
    for (const channel of this.channels.values()) {
      if (channel.head && !channel.paused) return true;
    }
    return false;
  }

  protected hasBlockedItems(): boolean {
    for (const channel of this.channels.values()) {
      if (channel.head?.blocked === true) return true;
    }
    return false;
  }

  protected readonly onUserGesture = (): void => this.unlockBlocked();

  /** Retries every blocked, unpaused channel (call from a user gesture). */
  protected unlockBlocked(): void {
    this.webAudio.resume();
    this.channels.forEach((channel) => {
      const head = channel.head;
      if (head?.blocked === true && !channel.paused) {
        head.blocked = false;
        void this.play(channel, head);
      }
    });
    if (!this.hasBlockedItems()) this.disarmUnlock();
  }

  protected armUnlock(): void {
    if (this.unlockArmed || typeof document === 'undefined') return;
    this.unlockArmed = true;
    UNLOCK_EVENTS.forEach((type) =>
      document.addEventListener(type, this.onUserGesture, { capture: true, passive: true })
    );
  }

  protected disarmUnlock(): void {
    if (!this.unlockArmed || typeof document === 'undefined') return;
    this.unlockArmed = false;
    UNLOCK_EVENTS.forEach((type) =>
      document.removeEventListener(type, this.onUserGesture, { capture: true })
    );
  }

  protected checkSlot(
    channel: Channel | undefined,
    slot: number,
    verb: string
  ): string | undefined {
    if (!channel) return 'Channel does not exist';
    const count = channel.items.length;
    if (!Number.isInteger(slot) || slot < 0 || slot >= count) {
      return `Invalid slot number ${String(slot)}: queue has ${count} items`;
    }
    if (slot === 0) {
      return `Cannot ${verb} the currently playing item (index 0)`;
    }
    return undefined;
  }

  protected afterManipulation(channel: Channel, changed: boolean = true): QueueManipulationResult {
    if (changed) {
      this.emitQueueChange(channel);
      this.refresh(channel);
    }
    return { success: true, updatedQueue: this.snapshot(channel) };
  }

  protected snapshot(channel: Channel): QueueSnapshot {
    return {
      channelNumber: channel.channelNumber,
      currentIndex: channel.items.length > 0 ? 0 : -1,
      isPaused: channel.paused,
      items: channel.describeItems(),
      totalItems: channel.items.length,
      volume: channel.volume
    };
  }

  protected emptySnapshot(channelNumber: number): QueueSnapshot {
    return {
      channelNumber,
      currentIndex: -1,
      isPaused: false,
      items: [],
      totalItems: 0,
      volume: 1
    };
  }

  protected describeHead(channel: Channel, item: Item): AudioInfo {
    const element = item.element;
    const duration = secondsToMs(element?.duration ?? NaN);
    const currentTime = secondsToMs(element?.currentTime ?? 0);
    const isPaused = channel.paused || (element?.paused ?? true);
    return {
      currentTime,
      duration,
      fileName: item.fileName,
      id: item.id,
      isLoading: (element?.readyState ?? 0) < 3,
      isLooping: item.loop,
      isPaused,
      isPlaying: !isPaused && item.started && !(element?.ended ?? false),
      metadata: item.metadata,
      playbackRate: channel.effectiveRate(),
      progress: duration > 0 ? Math.min(1, currentTime / duration) : 0,
      remainingInQueue: Math.max(0, channel.items.length - 1),
      src: item.src,
      volume: channel.effectiveGain(this.globalVolume)
    };
  }

  protected emitProgress(channel: Channel, item: Item): void {
    if (!this.emitter.has('progress', channel.channelNumber)) return;
    this.emitter.emit('progress', channel.channelNumber, this.describeHead(channel, item));
  }

  protected emitQueueChange(channel: Channel): void {
    if (!this.emitter.has('queuechange', channel.channelNumber)) return;
    this.emitter.emit('queuechange', channel.channelNumber, this.snapshot(channel));
  }

  protected emitError(
    channel: Channel,
    item: Item,
    errorType: AudioErrorType,
    error: Error,
    remainingInQueue: number
  ): void {
    this.emitter.emit('error', channel.channelNumber, {
      channelNumber: channel.channelNumber,
      error,
      errorType,
      fileName: item.fileName,
      id: item.id,
      metadata: item.metadata,
      remainingInQueue: Math.max(0, remainingInQueue),
      src: item.src,
      timestamp: Date.now()
    });
  }
}
