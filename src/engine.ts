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
  PLAYBACK_RATE_RANGE,
  clampPlaybackRate,
  defaultQueueConfig,
  getFadeConfig,
  mergeQueueConfig
} from './config.js';
import { Emitter } from './emitter.js';
import { peekMemory } from './memory.js';
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
  type AudioCue,
  type AudioCueInfo,
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
import {
  assertChannelNumber,
  clampUnit,
  extractFileName,
  MAX_TIMER_MS,
  secondsToMs,
  settleWithin
} from './utils.js';
import { WebAudioEngine, isWebAudioSupported, shouldUseWebAudio } from './web-audio.js';

/** Events emitted by a queue, with their payloads. */
export interface QueueEvents {
  complete: AudioCompleteInfo;
  cue: AudioCueInfo;
  error: AudioErrorInfo;
  pause: AudioInfo;
  progress: AudioInfo;
  queuechange: QueueSnapshot;
  resume: AudioInfo;
  start: AudioStartInfo;
}

/**
 * Events that grant "user activation" (permission to start audio) in browsers. pointerdown is
 * deliberately absent: for touch it does not grant activation, so playing there would fail.
 */
const UNLOCK_EVENTS: readonly string[] = ['mousedown', 'keydown', 'pointerup', 'touchend'];
const PROGRESS_EVENTS: readonly string[] = ['timeupdate', 'loadedmetadata', 'pause'];
/** Events after which the position tracker re-plans its next wake-up. */
const POSITION_EVENTS: readonly string[] = [
  'playing',
  'timeupdate',
  'seeked',
  'ratechange',
  'pause'
];
/** How close to `endAt` counts as reaching it (timers and media clocks are not exact). */
const END_TOLERANCE_MS = 10;
/** How far from `startAt` playback may begin before the seek is considered failed. */
const START_TOLERANCE_MS = 250;

/**
 * Validates and sorts cues.
 * @param cues - Cues given to queueAudio
 * @returns Cues sorted by start time (the original objects)
 */
const normalizeCues = (cues: AudioCue[] | undefined): readonly AudioCue[] => {
  if (cues === undefined) return [];
  for (const cue of cues) {
    const validStart = Number.isFinite(cue.startMs) && cue.startMs >= 0;
    const validEnd =
      cue.endMs === undefined || (Number.isFinite(cue.endMs) && cue.endMs > cue.startMs);
    if (!validStart || !validEnd) {
      throw new RangeError('Each cue needs startMs >= 0 and, if given, an endMs after startMs');
    }
  }
  return [...cues].sort((a, b) => a.startMs - b.startMs);
};

/**
 * The next position (ms) after `position` where something happens: a cue starts or ends, the
 * segment ends, or a crossfade begins.
 */
const nextBoundary = (
  item: Item,
  position: number,
  fadeAt: number | undefined
): number | undefined => {
  let next: number | undefined;
  const consider = (value: number | undefined): void => {
    if (value !== undefined && value > position && (next === undefined || value < next))
      next = value;
  };
  consider(item.endAt);
  consider(fadeAt);
  item.cues.forEach((cue) => {
    consider(cue.startMs);
    consider(cue.endMs);
  });
  return next;
};

/** Crossfade length for an item: the channel setting, but at most half of the item. */
const crossfadeLength = (channel: Channel, item: Item, end: number): number =>
  Math.min(channel.crossfadeMs, (end - item.segmentStart) / 2);

/**
 * Internal state and playback machinery shared by every AudioQueue. Not part of the public API.
 */
export class QueueEngine {
  protected readonly channels: Map<number, Channel> = new Map();
  protected config: QueueConfig;
  protected ducking: VolumeConfig | undefined;
  protected readonly emitter: Emitter<QueueEvents>;
  protected globalVolume: number = 1;
  protected globalMuted: boolean = false;
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
    const { fileName, objectUrl, src } = this.resolveSource(source, options);
    const startAt = Number.isFinite(options.startAt) ? Math.max(0, options.startAt as number) : 0;
    const endAt = options.endAt;
    if (endAt !== undefined && !(Number.isFinite(endAt) && endAt > startAt)) {
      throw new RangeError('endAt must be a finite number of milliseconds after startAt');
    }
    return this.buildItem(channelNumber, {
      crossOrigin: options.crossOrigin,
      cues: normalizeCues(options.cues),
      endAt,
      fileName,
      loop: options.loop === true,
      metadata: options.metadata,
      objectUrl,
      playbackRate: clampPlaybackRate(options.playbackRate),
      segmentStart: startAt,
      src,
      startAt,
      volume: clampUnit(options.volume ?? 1)
    });
  }

  /**
   * Works out where an item plays from. Blobs and preloaded URLs play from memory through an
   * object URL owned by the item; `src` stays the URL the caller gave.
   */
  protected resolveSource(
    source: AudioSource,
    options: AudioQueueOptions
  ): { fileName: string; objectUrl: string | undefined; src: string } {
    if (typeof source !== 'string') {
      const objectUrl = URL.createObjectURL(source);
      const name = (source as Blob & { name?: unknown }).name;
      const fileName =
        typeof name === 'string' && name.length > 0 ? name : (options.metadata?.title ?? 'audio');
      return { fileName, objectUrl, src: objectUrl };
    }
    const src = resolveUrl(source);
    const memory = peekMemory(this)?.files.get(src);
    const objectUrl = memory === undefined ? undefined : URL.createObjectURL(memory);
    return { fileName: extractFileName(src), objectUrl, src };
  }

  /** Creates an item plus its public handle from already-normalized settings. */
  protected buildItem(
    channelNumber: number,
    settings: Pick<
      Item,
      | 'crossOrigin'
      | 'cues'
      | 'endAt'
      | 'fileName'
      | 'loop'
      | 'metadata'
      | 'objectUrl'
      | 'playbackRate'
      | 'segmentStart'
      | 'src'
      | 'startAt'
      | 'volume'
    >
  ): { handle: QueuedAudio; item: Item } {
    let resolveStarted: (started: boolean) => void = () => undefined;
    let resolveFinished: (outcome: ItemOutcome) => void = () => undefined;
    const started: Promise<boolean> = new Promise((resolve) => (resolveStarted = resolve));
    const finished: Promise<ItemOutcome> = new Promise((resolve) => (resolveFinished = resolve));
    const item: Item = {
      ...settings,
      activeCues: new Set(),
      blocked: false,
      channelNumber,
      disposers: [],
      element: undefined,
      id: this.nextId++,
      lastCueMs: -1,
      loadTimer: undefined,
      playRequested: false,
      positionTimer: undefined,
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

  /** Adds an already-validated source to a channel (the body of queueAudio). */
  protected enqueue(
    channel: Channel,
    source: AudioSource,
    url: string | undefined,
    options: AudioQueueOptions
  ): QueuedAudio {
    const channelNumber = channel.channelNumber;
    const dedupeMs = options.dedupeMs ?? 0;
    if (url !== undefined && dedupeMs > 0 && channel.isDuplicate(url, dedupeMs, Date.now())) {
      return this.skippedHandle(channelNumber, url, options);
    }
    if (options.interrupt === true) this.clearChannel(channel);
    this.makeRoom(channel, options.maxQueueSize);
    const { handle, item } = this.createItem(url ?? source, channelNumber, options);
    if (options.addToFront === true && channel.items.length > 0) {
      channel.items.splice(1, 0, item);
    } else {
      channel.items.push(item);
    }
    this.emitQueueChange(channel);
    this.refresh(channel);
    return handle;
  }

  /** Makes sure the current item is playing (unless paused) and upcoming items are preloaded. */
  protected refresh(channel: Channel): void {
    channel.items.forEach((item, index) => {
      if (index <= this.config.prefetchCount) this.ensureElement(channel, item);
      else if (item.element) this.unload(item);
    });
    const head = channel.head;
    const waiting = channel.gapTimer !== undefined;
    if (head && !channel.paused && !head.playRequested && !head.blocked && !waiting) {
      void this.play(channel, head);
    }
    // The queue changed, so the next crossfade (which depends on there being a next item) moved.
    if (head?.started === true) this.trackPosition(channel, head);
    this.updateDucking();
  }

  protected ensureElement(channel: Channel, item: Item): HTMLAudioElement {
    if (item.element) return item.element;
    const element = new Audio();
    element.preload = 'auto';
    // Segments (endAt) loop themselves; a native loop would replay the whole file.
    element.loop = item.loop && item.endAt === undefined;
    element.preservesPitch = true;
    if (item.crossOrigin !== undefined) element.crossOrigin = item.crossOrigin;
    element.src = item.objectUrl ?? item.src;
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
        if (channel.outgoing === item) this.stopOutgoing(channel);
        else if (!item.settled) this.onElementError(channel, item);
      }),
      ...POSITION_EVENTS.map((type) =>
        listen(
          element,
          type,
          whenHead(() => this.trackPosition(channel, item))
        )
      ),
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

  /**
   * Routes an element through Web Audio when needed: always in 'force' mode or on iOS, and
   * elsewhere when its channel is panned (panning needs a StereoPannerNode).
   */
  protected routeThroughWebAudio(channel: Channel, item: Item, element: HTMLAudioElement): void {
    const mode = this.config.webAudio;
    const forPan = channel.pan !== 0 && mode !== 'off' && isWebAudioSupported();
    if (item.route || !(shouldUseWebAudio(mode) || forPan)) return;
    const pageUrl = typeof location === 'undefined' ? undefined : location.href;
    // Cross-origin media without CORS plays as silence through Web Audio, so only route sources
    // that are same-origin, preloaded, or explicitly loaded with CORS.
    const elementSource = item.objectUrl ?? item.src;
    if (item.crossOrigin === undefined && !isSameOriginSource(elementSource, pageUrl)) {
      if (forPan) {
        this.config.logger?.warn(`audioq: cannot pan ${item.fileName}: cross-origin without CORS`);
      }
      return;
    }
    const gain = channel.effectiveGain(this.masterGain());
    item.route = this.webAudio.connect(element, gain, channel.pan);
    // Routed audio is controlled by the gain node; the element itself plays at full volume.
    if (item.route) element.volume = 1;
  }

  /** Applies a channel's pan to its items, routing an already-playing item if needed. */
  protected applyPan(channel: Channel): void {
    for (const item of [channel.head, channel.outgoing]) {
      if (!item?.element) continue;
      this.routeThroughWebAudio(channel, item, item.element);
      if (item.route) this.webAudio.setPan(item.route, channel.pan);
    }
    this.applyGain(channel);
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
      attempt = Promise.reject(toError(error, 'play() threw'));
    }
    return attempt.then(
      () => undefined,
      (error: unknown) => this.onPlayRejected(channel, item, error)
    );
  }

  protected onPlaying(channel: Channel, item: Item): void {
    item.blocked = false;
    this.clearLoadTimer(item);
    if (!this.hasBlockedItems()) this.disarmUnlock();
    if (item.started) return;
    this.checkStartAt(item);
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
    const message = mediaError?.message ?? '';
    const error = new Error(message === '' ? `Media error (${type})` : message);
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
    // An error listener may already have skipped or stopped the item; never advance twice.
    if (channel.head === item && !item.settled) this.advance(channel, 'error');
  }

  /** Removes the current item and moves on to the next one. */
  protected advance(channel: Channel, reason: CompletionReason): void {
    const head = channel.items.shift();
    if (!head) return;
    // Skipping (`stopped`) plays the next item; an item that ends or fails while the user paused
    // (or while a pause is fading out) leaves the channel paused on the next item.
    const pauseIntent = channel.paused || channel.pendingPause;
    const stayPaused = reason !== 'stopped' && pauseIntent && channel.items.length > 0;
    const newlyPaused = stayPaused && !channel.paused;
    channel.paused = stayPaused;
    channel.pendingPause = false;
    this.resetFade(channel);
    this.retire(channel, head, reason, channel.items.length);
    this.emitQueueChange(channel);
    this.startGap(channel);
    this.refresh(channel);
    const next = channel.head;
    if (newlyPaused && next) {
      this.emitter.emit('pause', channel.channelNumber, this.describeHead(channel, next));
    }
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
    channel.pendingPause = false;
    channel.hiddenPause = false;
    channel.clearGap();
    this.stopOutgoing(channel);
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
    this.exitCues(item);
    item.started = false;
    item.playRequested = false;
    item.startAt = 0;
    item.lastCueMs = -1;
    if (item.element) item.element.currentTime = item.segmentStart / 1000;
    this.startGap(channel);
    this.refresh(channel);
  }

  /** Repeat-all: a fresh copy of a finished item for the end of the queue. */
  protected copyForRepeat(item: Item): Item {
    const { item: copy } = this.buildItem(item.channelNumber, {
      crossOrigin: item.crossOrigin,
      cues: item.cues,
      endAt: item.endAt,
      fileName: item.fileName,
      loop: item.loop,
      metadata: item.metadata,
      objectUrl: item.objectUrl,
      playbackRate: item.playbackRate,
      segmentStart: item.segmentStart,
      src: item.src,
      startAt: item.segmentStart,
      volume: item.volume
    });
    // The copy now owns the Blob's object URL, so releasing the original must not revoke it.
    item.objectUrl = undefined;
    return copy;
  }

  /**
   * Handles everything tied to the playback position (cues, segment ends, crossfades) and sleeps
   * until the next of those moments. Browsers only report the position about 4 times a second,
   * which is too coarse for short sprites, so a timer wakes the tracker at the exact time.
   */
  protected trackPosition(channel: Channel, item: Item): void {
    if (item.positionTimer !== undefined) clearTimeout(item.positionTimer);
    item.positionTimer = undefined;
    const element = item.element;
    if (!element || item.settled || channel.head !== item) return;
    const position = secondsToMs(element.currentTime);
    this.updateCues(channel, item, position);
    if (channel.paused || element.paused) return;
    if (item.endAt !== undefined && position >= item.endAt - END_TOLERANCE_MS) {
      this.reachSegmentEnd(channel, item);
      return;
    }
    const fadeAt = this.crossfadeStart(channel, item, element);
    if (fadeAt !== undefined && position >= fadeAt) {
      this.beginCrossfade(channel, item, element);
      return;
    }
    const next = nextBoundary(item, position, fadeAt);
    if (next === undefined) return;
    const delay = (next - position) / Math.max(element.playbackRate, PLAYBACK_RATE_RANGE[0]);
    item.positionTimer = setTimeout(
      () => this.trackPosition(channel, item),
      Math.min(Math.max(delay, 0), MAX_TIMER_MS)
    );
  }

  /** Fires enter/exit events for cues the position moved into or out of. */
  protected updateCues(channel: Channel, item: Item, position: number): void {
    const last = item.lastCueMs;
    item.lastCueMs = position;
    item.cues.forEach((cue, index) => {
      if (cue.endMs === undefined) {
        if (last < cue.startMs && cue.startMs <= position) this.emitCue(channel, item, index, true);
        return;
      }
      const inside = position >= cue.startMs && position < cue.endMs;
      if (inside === item.activeCues.has(index)) return;
      if (inside) item.activeCues.add(index);
      else item.activeCues.delete(index);
      this.emitCue(channel, item, index, inside);
    });
  }

  /** Ends every ranged cue still active on an item (it stopped, ended or restarted). */
  protected exitCues(item: Item): void {
    const channel = this.channels.get(item.channelNumber);
    const active = [...item.activeCues];
    item.activeCues.clear();
    if (channel) active.forEach((index) => this.emitCue(channel, item, index, false));
  }

  protected emitCue(channel: Channel, item: Item, index: number, active: boolean): void {
    const cue = item.cues[index];
    if (!cue) return;
    this.emitter.emit('cue', channel.channelNumber, {
      active,
      channelNumber: channel.channelNumber,
      cue,
      fileName: item.fileName,
      id: item.id,
      index,
      metadata: item.metadata,
      src: item.src
    });
  }

  /** The position reached `endAt`: loop the segment, or treat it as the end of the file. */
  protected reachSegmentEnd(channel: Channel, item: Item): void {
    const element = item.element;
    if (item.loop && element) {
      this.exitCues(item);
      item.lastCueMs = item.segmentStart - 1;
      element.currentTime = item.segmentStart / 1000;
      this.trackPosition(channel, item);
      return;
    }
    this.onEnded(channel, item);
  }

  /** Where the crossfade into the next item should start, if one applies. */
  protected crossfadeStart(
    channel: Channel,
    item: Item,
    element: HTMLAudioElement
  ): number | undefined {
    const end = item.endAt ?? secondsToMs(element.duration);
    const hasNext = channel.items.length > 1 || channel.repeat === 'all';
    if (channel.crossfadeMs <= 0 || item.loop || channel.repeat === 'one') return undefined;
    if (!hasNext || channel.pendingPause || !(end > item.segmentStart)) return undefined;
    return end - crossfadeLength(channel, item, end);
  }

  /** Starts the next item fading in while this one fades out, then lets this one go. */
  protected beginCrossfade(channel: Channel, item: Item, element: HTMLAudioElement): void {
    const fadeMs = crossfadeLength(channel, item, item.endAt ?? secondsToMs(element.duration));
    const startGain = channel.effectiveGain(this.masterGain());
    channel.items.shift();
    if (channel.repeat === 'all') channel.items.push(this.copyForRepeat(item));
    this.report(channel, item, 'ended', channel.items.length);
    this.exitCues(item);
    this.stopOutgoing(channel);
    channel.outgoing = item;
    const tween = startTween({
      duration: fadeMs,
      easing: EasingType.Linear,
      from: startGain,
      onUpdate: (value) => this.setItemGain(item, value),
      to: 0
    });
    channel.outgoingTween = tween;
    void tween.done.then(() => {
      if (channel.outgoing === item) this.stopOutgoing(channel);
    });
    channel.fadeTween?.cancel();
    channel.fadeFactor = 0;
    this.emitQueueChange(channel);
    this.refresh(channel);
    void this.fade(channel, 1, fadeMs, EasingType.Linear);
  }

  /** Releases the item that is fading out of a crossfade, if any. */
  protected stopOutgoing(channel: Channel): void {
    const outgoing = channel.outgoing;
    if (!outgoing) return;
    channel.outgoing = undefined;
    channel.outgoingTween?.cancel();
    channel.outgoingTween = undefined;
    this.finalize(outgoing, 'ended');
  }

  protected setItemGain(item: Item, gain: number): void {
    if (item.route) this.webAudio.setGain(item.route, gain);
    else if (item.element) item.element.volume = gain;
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
    this.exitCues(item);
    this.unload(item);
    if (item.objectUrl !== undefined) URL.revokeObjectURL(item.objectUrl);
    item.objectUrl = undefined;
    if (!item.started) item.resolveStarted(false);
    item.resolveFinished(outcome);
    if (!this.hasBlockedItems()) this.disarmUnlock();
  }

  /** Frees an item's element (network, decoder, listeners, Web Audio) but keeps it queued. */
  protected unload(item: Item): void {
    this.clearLoadTimer(item);
    if (item.positionTimer !== undefined) clearTimeout(item.positionTimer);
    item.positionTimer = undefined;
    item.disposers.forEach((dispose) => dispose());
    item.disposers = [];
    if (item.route) this.webAudio.disconnect(item.route);
    item.route = undefined;
    if (item.element) releaseElement(item.element);
    item.element = undefined;
    item.playRequested = false;
  }

  protected startLoadTimer(channel: Channel, item: Item): void {
    this.clearLoadTimer(item);
    const timeoutMs = this.config.loadTimeoutMs;
    if (item.started || timeoutMs <= 0) return;
    item.loadTimer = setTimeout(() => {
      item.loadTimer = undefined;
      if (channel.head !== item || item.settled || item.started || item.blocked) return;
      if (channel.paused) return;
      const error = new Error(`Audio did not start within ${timeoutMs}ms`);
      this.fail(channel, item, AudioErrorType.Timeout, error);
    }, timeoutMs);
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

  /**
   * Moves every channel towards its ducking target.
   * @param ducking - Settings for the transition; clearVolumeDucking passes the old settings so
   * the restore uses their restoreTransitionDuration
   */
  protected updateDucking(ducking: VolumeConfig | undefined = this.ducking): void {
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

  /** Global volume, or 0 while everything is muted. */
  protected masterGain(): number {
    return this.globalMuted ? 0 : this.globalVolume;
  }

  /** Applies a mute change: new gains everywhere, and a crossfade's fading tail goes silent. */
  protected applyMute(channels: Iterable<Channel>): void {
    for (const channel of channels) {
      if (this.globalMuted || channel.muted) this.stopOutgoing(channel);
      this.applyGain(channel);
    }
  }

  protected applyGain(channel: Channel): void {
    const head = channel.head;
    if (!head?.element) return;
    const gain = channel.effectiveGain(this.masterGain());
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

  /**
   * Seeks can fail silently: a server without HTTP Range support makes the file unseekable until
   * it has downloaded. If playback starts away from `startAt`, seek again once and say why.
   */
  protected checkStartAt(item: Item): void {
    const element = item.element;
    if (!element || item.startAt <= 0) return;
    if (Math.abs(element.currentTime * 1000 - item.startAt) <= START_TOLERANCE_MS) return;
    this.config.logger?.warn(
      `audioq: ${item.fileName} did not start at ${String(item.startAt)} ms: no HTTP Range support?`
    );
    try {
      element.currentTime = item.startAt / 1000;
    } catch {
      // Still not seekable; playback continues from where it is.
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
    channel.pendingPause = false;
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
    this.stopOutgoing(channel);
    channel.pendingPause = false;
    channel.paused = true;
    head.playRequested = false;
    this.clearLoadTimer(head);
    head.element?.pause();
    this.emitter.emit('pause', channel.channelNumber, this.describeHead(channel, head));
  }

  /**
   * Resumes a paused channel, or cancels a pause that is still fading out. Resolves once the
   * browser accepted or refused playback, or after `loadTimeoutMs` at most.
   */
  protected async resumeNow(channel: Channel): Promise<void> {
    const head = channel.head;
    if (!head) return;
    if (!channel.paused) {
      if (channel.pendingPause) {
        channel.pendingPause = false;
        this.resetFade(channel);
      }
      return;
    }
    this.resetFade(channel);
    channel.paused = false;
    channel.hiddenPause = false;
    const attempt = channel.gapTimer === undefined ? this.play(channel, head) : undefined;
    this.emitter.emit('resume', channel.channelNumber, this.describeHead(channel, head));
    if (attempt) await settleWithin(attempt, this.config.loadTimeoutMs);
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

  /** Stops a channel and forgets it, synchronously (no awaits, so nothing can interleave). */
  protected destroyNow(channelNumber: number): void {
    const channel = this.channels.get(channelNumber);
    if (channel) {
      this.clearChannel(channel);
      channel.cancelTweens();
      this.channels.delete(channelNumber);
    }
    this.emitter.clearChannel(channelNumber);
    this.updateDucking();
  }

  /** Whether a channel is paused or a pause is fading out (so a toggle should resume). */
  protected isPausedOrPausing(channelNumber: number): boolean {
    const channel = this.channels.get(channelNumber);
    return channel !== undefined && (channel.paused || channel.pendingPause);
  }

  protected anyPlaying(): boolean {
    for (const channel of this.channels.values()) {
      if (channel.head && !channel.paused && !channel.pendingPause) return true;
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
      // `blocked` stays set until the `playing` event, so a gesture that does not grant
      // permission does not report the same blocked item again.
      if (head?.blocked === true && !channel.paused) void this.play(channel, head);
    });
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
      volume: channel.effectiveGain(this.masterGain())
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
