/**
 * @fileoverview The AudioQueue class: independent channels, each playing its queue in order.
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
  defaultQueueConfig,
  getFadeConfig,
  mergeQueueConfig,
  validateVolumeConfig
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
  type AudioCompleteCallback,
  type AudioCompleteInfo,
  type AudioErrorCallback,
  type AudioErrorInfo,
  type AudioInfo,
  type AudioPauseCallback,
  type AudioQueueOptions,
  type AudioResumeCallback,
  type AudioStartCallback,
  type AudioStartInfo,
  type CompletionReason,
  type ItemOutcome,
  type ProgressCallback,
  type QueueChangeCallback,
  type QueueConfig,
  type QueueItem,
  type QueueManipulationResult,
  type QueueSnapshot,
  type QueuedAudio,
  type Unsubscribe,
  type VolumeConfig,
  type WebAudioSupport
} from './types.js';
import { assertChannelNumber, clampUnit, extractFileName, secondsToMs } from './utils.js';
import { WebAudioEngine, describeWebAudioSupport, shouldUseWebAudio } from './web-audio.js';

interface QueueEvents {
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
 * Manages audio channels, each with its own queue, volume, pause state and events.
 * Create one with {@link createAudioQueue}, or use the default instance through the package's
 * top-level functions.
 */
export class AudioQueue {
  private readonly channels: Map<number, Channel> = new Map();
  private config: QueueConfig;
  private ducking: VolumeConfig | undefined;
  private readonly emitter: Emitter<QueueEvents>;
  private globalVolume: number = 1;
  private nextId: number = 1;
  private unlockArmed: boolean = false;
  private readonly webAudio: WebAudioEngine = new WebAudioEngine();

  /**
   * @param config - Configuration overrides; see {@link QueueConfig}
   */
  constructor(config: Partial<QueueConfig> = {}) {
    this.config = mergeQueueConfig(defaultQueueConfig(), config);
    this.emitter = new Emitter<QueueEvents>((error) =>
      this.config.logger?.error('audioq: error in event listener', error)
    );
  }

  // ---------------------------------------------------------------- configuration

  /**
   * Updates the configuration. Changes apply to future operations.
   * @param config - Settings to change
   * @example
   * ```typescript
   * setQueueConfig({ defaultMaxQueueSize: 20, dropOldestWhenFull: true });
   * ```
   */
  setQueueConfig(config: Partial<QueueConfig>): void {
    this.config = mergeQueueConfig(this.config, config);
  }

  /**
   * Returns the current configuration.
   * @returns A copy of the configuration
   */
  getQueueConfig(): QueueConfig {
    return { ...this.config };
  }

  /**
   * Sets the queue limit for one channel (including the playing item).
   * @param channelNumber - Channel to configure
   * @param maxSize - Maximum items, or undefined to fall back to `defaultMaxQueueSize`
   */
  setChannelQueueLimit(channelNumber: number, maxSize?: number): void {
    if (maxSize !== undefined && !(maxSize >= 1)) {
      throw new RangeError('maxSize must be at least 1');
    }
    this.channel(channelNumber).maxQueueSize = maxSize;
  }

  /**
   * Describes whether Web Audio is available and used for new items.
   * @returns Web Audio support information
   */
  getWebAudioSupport(): WebAudioSupport {
    return describeWebAudioSupport(this.config.webAudio);
  }

  // ---------------------------------------------------------------- queueing

  /**
   * Adds an audio file to a channel. If the channel is idle it starts playing right away.
   * Resolves as soon as the item is queued; use the returned handle to await start or finish.
   * @param audioUrl - URL of the file (relative, absolute, blob: or data:)
   * @param channelNumber - Channel to queue on (defaults to 0)
   * @param options - Per-item options
   * @returns Handle with `started` and `finished` promises
   * @example
   * ```typescript
   * const item = await queueAudio('/sfx/click.mp3');
   * await item.finished; // 'ended' | 'stopped' | 'error' | 'removed'
   * await queueAudio('/music/theme.mp3', 1, { loop: true, volume: 0.5 });
   * ```
   */
  async queueAudio(
    audioUrl: string,
    channelNumber: number = 0,
    options: AudioQueueOptions = {}
  ): Promise<QueuedAudio> {
    if (typeof audioUrl !== 'string' || audioUrl.trim().length === 0) {
      throw new TypeError('audioUrl must be a non-empty string');
    }
    if (typeof Audio === 'undefined') {
      throw new Error('audioq needs a browser environment (HTMLAudioElement is not available)');
    }
    const channel = this.channel(channelNumber);
    this.makeRoom(channel, options.maxQueueSize);
    const { handle, item } = this.createItem(audioUrl.trim(), channelNumber, options);
    if (options.addToFront === true && channel.items.length > 0) {
      channel.items.splice(1, 0, item);
    } else {
      channel.items.push(item);
    }
    this.emitQueueChange(channel);
    this.refresh(channel);
    return handle;
  }

  /**
   * Adds an audio file right after the currently playing item.
   * @param audioUrl - URL of the file
   * @param channelNumber - Channel to queue on (defaults to 0)
   * @param options - Per-item options
   * @returns Handle with `started` and `finished` promises
   */
  async queueAudioPriority(
    audioUrl: string,
    channelNumber: number = 0,
    options: AudioQueueOptions = {}
  ): Promise<QueuedAudio> {
    return this.queueAudio(audioUrl, channelNumber, { ...options, addToFront: true });
  }

  // ---------------------------------------------------------------- stopping

  /**
   * Stops the current item and starts the next one.
   * @param channelNumber - Channel (defaults to 0)
   */
  async stopCurrentAudioInChannel(channelNumber: number = 0): Promise<void> {
    const channel = this.existing(channelNumber);
    if (channel?.head) this.advance(channel, 'stopped');
  }

  /**
   * Stops the current item and removes everything queued on the channel.
   * @param channelNumber - Channel (defaults to 0)
   */
  async stopAllAudioInChannel(channelNumber: number = 0): Promise<void> {
    const channel = this.existing(channelNumber);
    if (!channel) return;
    const removed = channel.items.splice(0, channel.items.length);
    channel.paused = false;
    this.resetFade(channel);
    const [head, ...rest] = removed;
    if (head) this.emitComplete(channel, head, 'stopped');
    if (head) this.finalize(head, 'stopped');
    rest.forEach((item) => this.finalize(item, 'removed'));
    if (removed.length > 0) this.emitQueueChange(channel);
    this.updateDucking();
  }

  /** Stops and clears every channel. */
  async stopAllAudio(): Promise<void> {
    for (const channelNumber of [...this.channels.keys()]) {
      await this.stopAllAudioInChannel(channelNumber);
    }
  }

  /**
   * Stops a channel, removes its listeners and forgets its settings.
   * @param channelNumber - Channel (defaults to 0)
   */
  async destroyChannel(channelNumber: number = 0): Promise<void> {
    await this.stopAllAudioInChannel(channelNumber);
    this.channels.get(channelNumber)?.cancelTweens();
    this.channels.delete(channelNumber);
    this.emitter.clearChannel(channelNumber);
    this.updateDucking();
  }

  /**
   * Destroys every channel, removes all listeners and closes the shared AudioContext.
   * The queue can still be used afterwards.
   */
  async destroyAllChannels(): Promise<void> {
    for (const channelNumber of [...this.channels.keys()]) {
      await this.destroyChannel(channelNumber);
    }
    this.emitter.clear();
    this.ducking = undefined;
    this.disarmUnlock();
    this.webAudio.close();
  }

  // ---------------------------------------------------------------- queue manipulation

  /**
   * Removes a waiting item. The current item (index 0) cannot be removed; stop it instead.
   * @param queuedSlotNumber - Index of the item (1 or more)
   * @param channelNumber - Channel (defaults to 0)
   * @returns Whether it worked, and the updated queue
   */
  async removeQueuedItem(
    queuedSlotNumber: number,
    channelNumber: number = 0
  ): Promise<QueueManipulationResult> {
    const channel = this.existing(channelNumber);
    const problem = this.checkSlot(channel, queuedSlotNumber, 'remove');
    if (problem !== undefined || !channel) return { error: problem, success: false };
    const [item] = channel.items.splice(queuedSlotNumber, 1);
    if (item) this.finalize(item, 'removed');
    return this.afterManipulation(channel);
  }

  /**
   * Moves a waiting item to another waiting position.
   * @param currentQueuedSlotNumber - Current index (1 or more)
   * @param newQueuedSlotNumber - New index (1 or more)
   * @param channelNumber - Channel (defaults to 0)
   * @returns Whether it worked, and the updated queue
   */
  async reorderQueue(
    currentQueuedSlotNumber: number,
    newQueuedSlotNumber: number,
    channelNumber: number = 0
  ): Promise<QueueManipulationResult> {
    const channel = this.existing(channelNumber);
    const problem =
      this.checkSlot(channel, currentQueuedSlotNumber, 'move') ??
      this.checkSlot(channel, newQueuedSlotNumber, 'move to');
    if (problem !== undefined || !channel) return { error: problem, success: false };
    const [item] = channel.items.splice(currentQueuedSlotNumber, 1);
    if (item) channel.items.splice(newQueuedSlotNumber, 0, item);
    return this.afterManipulation(channel, currentQueuedSlotNumber !== newQueuedSlotNumber);
  }

  /**
   * Swaps two waiting items.
   * @param slotA - Index of the first item (1 or more)
   * @param slotB - Index of the second item (1 or more)
   * @param channelNumber - Channel (defaults to 0)
   * @returns Whether it worked, and the updated queue
   */
  async swapQueueItems(
    slotA: number,
    slotB: number,
    channelNumber: number = 0
  ): Promise<QueueManipulationResult> {
    const channel = this.existing(channelNumber);
    const problem =
      this.checkSlot(channel, slotA, 'swap') ?? this.checkSlot(channel, slotB, 'swap');
    if (problem !== undefined || !channel) return { error: problem, success: false };
    const a = channel.items[slotA] as Item;
    channel.items[slotA] = channel.items[slotB] as Item;
    channel.items[slotB] = a;
    return this.afterManipulation(channel, slotA !== slotB);
  }

  /**
   * Removes every waiting item; the current item keeps playing.
   * @param channelNumber - Channel (defaults to 0)
   * @returns Whether it worked, and the updated queue
   */
  async clearQueueAfterCurrent(channelNumber: number = 0): Promise<QueueManipulationResult> {
    const channel = this.existing(channelNumber);
    if (!channel) return { success: true, updatedQueue: this.emptySnapshot(channelNumber) };
    const removed = channel.items.splice(1);
    removed.forEach((item) => this.finalize(item, 'removed'));
    return this.afterManipulation(channel, removed.length > 0);
  }

  /**
   * Describes one queued item.
   * @param queueSlotNumber - Index of the item (0 is current)
   * @param channelNumber - Channel (defaults to 0)
   * @returns Item information, or null when the slot is empty
   */
  getQueueItemInfo(queueSlotNumber: number, channelNumber: number = 0): QueueItem | null {
    const channel = this.existing(channelNumber);
    return channel?.describeItems()[queueSlotNumber] ?? null;
  }

  /**
   * Counts the items on a channel, including the current one.
   * @param channelNumber - Channel (defaults to 0)
   * @returns Number of items
   */
  getQueueLength(channelNumber: number = 0): number {
    return this.existing(channelNumber)?.items.length ?? 0;
  }

  // ---------------------------------------------------------------- pause and resume

  /**
   * Pauses a channel.
   * @param channelNumber - Channel (defaults to 0)
   */
  async pauseChannel(channelNumber: number = 0): Promise<void> {
    const channel = this.existing(channelNumber);
    const head = channel?.head;
    if (!channel || !head || channel.paused) return;
    channel.fadeTween?.cancel();
    channel.paused = true;
    head.playRequested = false;
    this.clearLoadTimer(head);
    head.element?.pause();
    this.emitter.emit('pause', channel.channelNumber, this.describeHead(channel, head));
  }

  /**
   * Resumes a paused channel. Resolves once the browser has accepted or refused playback.
   * @param channelNumber - Channel (defaults to 0)
   */
  async resumeChannel(channelNumber: number = 0): Promise<void> {
    const channel = this.existing(channelNumber);
    const head = channel?.head;
    if (!channel || !head || !channel.paused) return;
    this.resetFade(channel);
    channel.paused = false;
    const attempt = this.play(channel, head);
    this.emitter.emit('resume', channel.channelNumber, this.describeHead(channel, head));
    await attempt;
  }

  /**
   * Pauses a playing channel or resumes a paused one.
   * @param channelNumber - Channel (defaults to 0)
   */
  async togglePauseChannel(channelNumber: number = 0): Promise<void> {
    if (this.existing(channelNumber)?.paused === true) {
      await this.resumeChannel(channelNumber);
    } else {
      await this.pauseChannel(channelNumber);
    }
  }

  /** Pauses every channel. */
  async pauseAllChannels(): Promise<void> {
    await Promise.all([...this.channels.keys()].map((n) => this.pauseChannel(n)));
  }

  /** Resumes every paused channel. */
  async resumeAllChannels(): Promise<void> {
    await Promise.all([...this.channels.keys()].map((n) => this.resumeChannel(n)));
  }

  /** Pauses everything if anything is playing, otherwise resumes everything. */
  async togglePauseAllChannels(): Promise<void> {
    if (this.anyPlaying()) await this.pauseAllChannels();
    else await this.resumeAllChannels();
  }

  /**
   * Fades a channel out, then pauses it. Calling a resume during the fade cancels the pause.
   * @param fadeType - Fade preset (defaults to Gentle)
   * @param channelNumber - Channel (defaults to 0)
   * @param duration - Fade length in ms (defaults to the preset's duration)
   */
  async pauseWithFade(
    fadeType: FadeType = FadeType.Gentle,
    channelNumber: number = 0,
    duration?: number
  ): Promise<void> {
    const channel = this.existing(channelNumber);
    if (!channel?.head || channel.paused) return;
    const preset = getFadeConfig(fadeType);
    channel.lastFade = { duration, fadeType };
    const completed = await this.fade(channel, 0, duration ?? preset.duration, preset.pauseCurve);
    if (completed) await this.pauseChannel(channelNumber);
  }

  /**
   * Resumes a channel and fades it in. Also cancels a fade-out that is still running.
   * @param fadeType - Fade preset (defaults to the one used to pause)
   * @param channelNumber - Channel (defaults to 0)
   * @param duration - Fade length in ms (defaults to the pause fade's length)
   */
  async resumeWithFade(
    fadeType?: FadeType,
    channelNumber: number = 0,
    duration?: number
  ): Promise<void> {
    const channel = this.existing(channelNumber);
    const head = channel?.head;
    if (!channel || !head) return;
    const fadingOut = channel.fadeTween !== undefined && channel.fadeFactor < 1;
    if (!channel.paused && !fadingOut) return;
    const { curve, length } = this.resumeFadeSettings(channel, fadeType, duration);
    channel.fadeTween?.cancel();
    if (channel.paused) {
      channel.fadeFactor = 0;
      channel.paused = false;
      void this.play(channel, head);
      this.emitter.emit('resume', channel.channelNumber, this.describeHead(channel, head));
    }
    await this.fade(channel, 1, length, curve);
  }

  /**
   * Fades out and pauses a playing channel, or resumes and fades in a paused one.
   * @param fadeType - Fade preset used when pausing (defaults to Gentle)
   * @param channelNumber - Channel (defaults to 0)
   * @param duration - Fade length in ms
   */
  async togglePauseWithFade(
    fadeType: FadeType = FadeType.Gentle,
    channelNumber: number = 0,
    duration?: number
  ): Promise<void> {
    if (this.existing(channelNumber)?.paused === true) {
      await this.resumeWithFade(undefined, channelNumber, duration);
    } else {
      await this.pauseWithFade(fadeType, channelNumber, duration);
    }
  }

  /**
   * Fades out and pauses every channel.
   * @param fadeType - Fade preset (defaults to Gentle)
   * @param duration - Fade length in ms
   */
  async pauseAllWithFade(fadeType: FadeType = FadeType.Gentle, duration?: number): Promise<void> {
    await Promise.all(
      [...this.channels.keys()].map((n) => this.pauseWithFade(fadeType, n, duration))
    );
  }

  /**
   * Resumes and fades in every paused channel.
   * @param fadeType - Fade preset (defaults to each channel's pause preset)
   * @param duration - Fade length in ms
   */
  async resumeAllWithFade(fadeType?: FadeType, duration?: number): Promise<void> {
    await Promise.all(
      [...this.channels.keys()].map((n) => this.resumeWithFade(fadeType, n, duration))
    );
  }

  /**
   * Fades everything out if anything is playing, otherwise fades everything back in.
   * @param fadeType - Fade preset (defaults to Gentle)
   * @param duration - Fade length in ms
   */
  async togglePauseAllWithFade(
    fadeType: FadeType = FadeType.Gentle,
    duration?: number
  ): Promise<void> {
    if (this.anyPlaying()) await this.pauseAllWithFade(fadeType, duration);
    else await this.resumeAllWithFade(fadeType, duration);
  }

  /**
   * Whether a channel is paused.
   * @param channelNumber - Channel (defaults to 0)
   * @returns True when paused
   */
  isChannelPaused(channelNumber: number = 0): boolean {
    return this.existing(channelNumber)?.paused ?? false;
  }

  /**
   * Pause state of every channel, indexed by channel number.
   * @returns One boolean per channel up to the highest channel used
   */
  getAllChannelsPauseState(): boolean[] {
    return this.perChannel((channel) => channel?.paused ?? false);
  }

  // ---------------------------------------------------------------- volume

  /**
   * Sets a channel's volume, optionally with a transition. Works on idle channels too.
   * @param channelNumber - Channel
   * @param volume - Volume (0-1)
   * @param transitionDuration - Transition length in ms (instant when omitted or 0)
   * @param easing - Transition curve (defaults to ease-out)
   */
  async setChannelVolume(
    channelNumber: number,
    volume: number,
    transitionDuration?: number,
    easing: EasingType = EasingType.EaseOut
  ): Promise<void> {
    const channel = this.channel(channelNumber);
    const target = clampUnit(volume, channel.volume);
    channel.volumeTween?.cancel();
    const tween = startTween({
      duration: transitionDuration ?? 0,
      easing,
      from: channel.volume,
      onUpdate: (value) => {
        channel.volume = value;
        this.applyGain(channel);
      },
      to: target
    });
    channel.volumeTween = tween;
    await tween.done;
    if (channel.volumeTween === tween) channel.volumeTween = undefined;
  }

  /**
   * Transitions a channel's volume over time.
   * @param channelNumber - Channel
   * @param targetVolume - Volume to reach (0-1)
   * @param duration - Transition length in ms (defaults to 250)
   * @param easing - Transition curve (defaults to ease-out)
   */
  async transitionVolume(
    channelNumber: number,
    targetVolume: number,
    duration: number = 250,
    easing: EasingType = EasingType.EaseOut
  ): Promise<void> {
    await this.setChannelVolume(channelNumber, targetVolume, duration, easing);
  }

  /**
   * Stops a running volume transition where it is.
   * @param channelNumber - Channel
   */
  cancelVolumeTransition(channelNumber: number): void {
    const channel = this.existing(channelNumber);
    channel?.volumeTween?.cancel();
    if (channel) channel.volumeTween = undefined;
  }

  /** Stops every running volume transition. */
  cancelAllVolumeTransitions(): void {
    for (const channelNumber of this.channels.keys()) this.cancelVolumeTransition(channelNumber);
  }

  /**
   * Reads a channel's volume.
   * @param channelNumber - Channel (defaults to 0)
   * @returns Volume (0-1); 1 for unused channels
   */
  getChannelVolume(channelNumber: number = 0): number {
    return this.existing(channelNumber)?.volume ?? 1;
  }

  /**
   * Volumes of every channel, indexed by channel number.
   * @returns One volume per channel up to the highest channel used
   */
  getAllChannelsVolume(): number[] {
    return this.perChannel((channel) => channel?.volume ?? 1);
  }

  /**
   * Sets the same volume on every channel in use.
   * @param volume - Volume (0-1)
   */
  async setAllChannelsVolume(volume: number): Promise<void> {
    await Promise.all([...this.channels.keys()].map((n) => this.setChannelVolume(n, volume)));
  }

  /**
   * Sets the global volume, which multiplies every channel's volume.
   * @param volume - Volume (0-1)
   */
  async setGlobalVolume(volume: number): Promise<void> {
    this.globalVolume = clampUnit(volume, this.globalVolume);
    this.channels.forEach((channel) => this.applyGain(channel));
  }

  /**
   * Reads the global volume.
   * @returns Global volume (0-1)
   */
  getGlobalVolume(): number {
    return this.globalVolume;
  }

  /**
   * Lowers every other channel while the priority channel has audio queued.
   * Channels that start during ducking are ducked too.
   * @param config - Ducking settings
   */
  setVolumeDucking(config: VolumeConfig): void {
    this.ducking = validateVolumeConfig(config, this.config.maxChannels);
    this.updateDucking();
  }

  /** Turns ducking off and restores every channel. */
  clearVolumeDucking(): void {
    this.ducking = undefined;
    this.updateDucking();
  }

  // ---------------------------------------------------------------- information

  /**
   * Describes the current item of a channel.
   * @param channelNumber - Channel (defaults to 0)
   * @returns Playback information, or null when nothing is queued
   */
  getCurrentAudioInfo(channelNumber: number = 0): AudioInfo | null {
    const channel = this.existing(channelNumber);
    const head = channel?.head;
    return channel && head ? this.describeHead(channel, head) : null;
  }

  /**
   * Describes the current item of every channel, indexed by channel number.
   * @returns One entry per channel up to the highest channel used
   */
  getAllChannelsInfo(): (AudioInfo | null)[] {
    return this.perChannel((channel) =>
      channel?.head ? this.describeHead(channel, channel.head) : null
    );
  }

  /**
   * Describes a channel's whole queue.
   * @param channelNumber - Channel (defaults to 0)
   * @returns The snapshot, or null for a channel that was never used
   */
  getQueueSnapshot(channelNumber: number = 0): QueueSnapshot | null {
    const channel = this.existing(channelNumber);
    return channel ? this.snapshot(channel) : null;
  }

  /**
   * Calls `unlockAudio` from your own click or key handler to start sounds the browser blocked.
   * audioq also does this automatically on the next pointer or key press.
   */
  unlockAudio(): void {
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

  // ---------------------------------------------------------------- events

  /**
   * Listens for progress updates of a channel's current item.
   * @param channelNumber - Channel
   * @param callback - Listener
   * @returns Function that removes this listener
   */
  onAudioProgress(channelNumber: number, callback: ProgressCallback): Unsubscribe {
    return this.subscribe('progress', channelNumber, callback);
  }

  /**
   * Removes progress listeners.
   * @param channelNumber - Channel (defaults to 0)
   * @param callback - Remove only this listener; omit to remove all on the channel
   */
  offAudioProgress(channelNumber: number = 0, callback?: ProgressCallback): void {
    this.emitter.off('progress', channelNumber, callback);
  }

  /**
   * Listens for queue changes on a channel.
   * @param channelNumber - Channel
   * @param callback - Listener
   * @returns Function that removes this listener
   */
  onQueueChange(channelNumber: number, callback: QueueChangeCallback): Unsubscribe {
    return this.subscribe('queuechange', channelNumber, callback);
  }

  /**
   * Removes queue change listeners.
   * @param channelNumber - Channel (defaults to 0)
   * @param callback - Remove only this listener; omit to remove all on the channel
   */
  offQueueChange(channelNumber: number = 0, callback?: QueueChangeCallback): void {
    this.emitter.off('queuechange', channelNumber, callback);
  }

  /**
   * Listens for playback starts on a channel.
   * @param channelNumber - Channel
   * @param callback - Listener
   * @returns Function that removes this listener
   */
  onAudioStart(channelNumber: number, callback: AudioStartCallback): Unsubscribe {
    return this.subscribe('start', channelNumber, callback);
  }

  /**
   * Removes start listeners.
   * @param channelNumber - Channel (defaults to 0)
   * @param callback - Remove only this listener; omit to remove all on the channel
   */
  offAudioStart(channelNumber: number = 0, callback?: AudioStartCallback): void {
    this.emitter.off('start', channelNumber, callback);
  }

  /**
   * Listens for items leaving the front of a channel (ended, stopped or failed).
   * @param channelNumber - Channel
   * @param callback - Listener
   * @returns Function that removes this listener
   */
  onAudioComplete(channelNumber: number, callback: AudioCompleteCallback): Unsubscribe {
    return this.subscribe('complete', channelNumber, callback);
  }

  /**
   * Removes complete listeners.
   * @param channelNumber - Channel (defaults to 0)
   * @param callback - Remove only this listener; omit to remove all on the channel
   */
  offAudioComplete(channelNumber: number = 0, callback?: AudioCompleteCallback): void {
    this.emitter.off('complete', channelNumber, callback);
  }

  /**
   * Listens for pauses on a channel.
   * @param channelNumber - Channel
   * @param callback - Listener, called with the channel number and playback information
   * @returns Function that removes this listener
   */
  onAudioPause(channelNumber: number, callback: AudioPauseCallback): Unsubscribe {
    assertChannelNumber(channelNumber, this.config.maxChannels);
    return this.emitter.on(
      'pause',
      channelNumber,
      (info) => callback(channelNumber, info),
      callback
    );
  }

  /**
   * Removes pause listeners.
   * @param channelNumber - Channel (defaults to 0)
   * @param callback - Remove only this listener; omit to remove all on the channel
   */
  offAudioPause(channelNumber: number = 0, callback?: AudioPauseCallback): void {
    this.emitter.off('pause', channelNumber, callback);
  }

  /**
   * Listens for resumes on a channel.
   * @param channelNumber - Channel
   * @param callback - Listener, called with the channel number and playback information
   * @returns Function that removes this listener
   */
  onAudioResume(channelNumber: number, callback: AudioResumeCallback): Unsubscribe {
    assertChannelNumber(channelNumber, this.config.maxChannels);
    return this.emitter.on(
      'resume',
      channelNumber,
      (info) => callback(channelNumber, info),
      callback
    );
  }

  /**
   * Removes resume listeners.
   * @param channelNumber - Channel (defaults to 0)
   * @param callback - Remove only this listener; omit to remove all on the channel
   */
  offAudioResume(channelNumber: number = 0, callback?: AudioResumeCallback): void {
    this.emitter.off('resume', channelNumber, callback);
  }

  /**
   * Listens for errors on a channel. Failed items are skipped automatically; a blocked autoplay
   * keeps the item and retries on the next user gesture.
   * @param channelNumber - Channel
   * @param callback - Listener
   * @returns Function that removes this listener
   */
  onAudioError(channelNumber: number, callback: AudioErrorCallback): Unsubscribe {
    return this.subscribe('error', channelNumber, callback);
  }

  /**
   * Removes error listeners.
   * @param channelNumber - Channel (defaults to 0)
   * @param callback - Remove only this listener; omit to remove all on the channel
   */
  offAudioError(channelNumber: number = 0, callback?: AudioErrorCallback): void {
    this.emitter.off('error', channelNumber, callback);
  }

  // ================================================================ internals

  private subscribe<K extends keyof QueueEvents>(
    event: K,
    channelNumber: number,
    callback: (payload: QueueEvents[K]) => void
  ): Unsubscribe {
    assertChannelNumber(channelNumber, this.config.maxChannels);
    return this.emitter.on(event, channelNumber, callback);
  }

  private channel(channelNumber: number): Channel {
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

  private existing(channelNumber: number): Channel | undefined {
    return this.channels.get(channelNumber);
  }

  private perChannel<T>(read: (channel: Channel | undefined) => T): T[] {
    const highest = Math.max(-1, ...this.channels.keys());
    return Array.from({ length: highest + 1 }, (_unused, n) => read(this.channels.get(n)));
  }

  private makeRoom(channel: Channel, override: number | undefined): void {
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

  private createItem(
    url: string,
    channelNumber: number,
    options: AudioQueueOptions
  ): { handle: QueuedAudio; item: Item } {
    let resolveStarted: (started: boolean) => void = () => undefined;
    let resolveFinished: (outcome: ItemOutcome) => void = () => undefined;
    const started = new Promise<boolean>((resolve) => (resolveStarted = resolve));
    const finished = new Promise<ItemOutcome>((resolve) => (resolveFinished = resolve));
    const item: Item = {
      blocked: false,
      channelNumber,
      crossOrigin: options.crossOrigin,
      disposers: [],
      element: undefined,
      id: this.nextId++,
      loadTimer: undefined,
      loop: options.loop === true,
      playRequested: false,
      resolveFinished,
      resolveStarted,
      route: undefined,
      settled: false,
      src: resolveUrl(url),
      started: false,
      volume: clampUnit(options.volume ?? 1)
    };
    const handle: QueuedAudio = { channelNumber, finished, id: item.id, src: item.src, started };
    return { handle, item };
  }

  /** Makes sure the current item is playing (unless paused) and upcoming items are preloaded. */
  private refresh(channel: Channel): void {
    const upcoming = channel.items.slice(0, this.config.prefetchCount + 1);
    upcoming.forEach((item) => this.ensureElement(channel, item));
    const head = channel.head;
    if (head && !channel.paused && !head.playRequested && !head.blocked) {
      void this.play(channel, head);
    }
    this.updateDucking();
  }

  private ensureElement(channel: Channel, item: Item): HTMLAudioElement {
    if (item.element) return item.element;
    const element = new Audio();
    element.preload = 'auto';
    element.loop = item.loop;
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
        whenHead(() => this.advance(channel, 'ended'))
      ),
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

  private routeThroughWebAudio(channel: Channel, item: Item, element: HTMLAudioElement): void {
    if (!shouldUseWebAudio(this.config.webAudio)) return;
    const pageOrigin = typeof location === 'undefined' ? undefined : location.origin;
    // Cross-origin media without CORS plays as silence through Web Audio, so only route sources
    // that are same-origin or explicitly loaded with CORS.
    if (item.crossOrigin === undefined && !isSameOriginSource(item.src, pageOrigin)) return;
    item.route = this.webAudio.connect(element, channel.effectiveGain(this.globalVolume));
  }

  private play(channel: Channel, item: Item): Promise<void> {
    const element = this.ensureElement(channel, item);
    item.playRequested = true;
    this.applyGain(channel);
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

  private onPlaying(channel: Channel, item: Item): void {
    item.blocked = false;
    this.clearLoadTimer(item);
    if (item.started) return;
    item.started = true;
    item.resolveStarted(true);
    this.emitter.emit('start', channel.channelNumber, {
      channelNumber: channel.channelNumber,
      duration: secondsToMs(item.element?.duration ?? NaN),
      fileName: extractFileName(item.src),
      src: item.src
    });
  }

  private onPlayRejected(channel: Channel, item: Item, error: unknown): void {
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

  private onElementError(channel: Channel, item: Item): void {
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

  private fail(channel: Channel, item: Item, type: AudioErrorType, error: Error): void {
    this.emitError(channel, item, type, error, channel.items.length - 1);
    this.advance(channel, 'error');
  }

  /** Removes the current item and moves on to the next one. */
  private advance(channel: Channel, reason: CompletionReason): void {
    const head = channel.items.shift();
    if (!head) return;
    channel.paused = false;
    this.resetFade(channel);
    this.emitComplete(channel, head, reason);
    this.finalize(head, reason);
    this.emitQueueChange(channel);
    this.refresh(channel);
  }

  /** Releases everything an item holds. Safe to call more than once. */
  private finalize(item: Item, outcome: ItemOutcome): void {
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
    if (!item.started) item.resolveStarted(false);
    item.resolveFinished(outcome);
    if (!this.hasBlockedItems()) this.disarmUnlock();
  }

  private startLoadTimer(channel: Channel, item: Item): void {
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

  private clearLoadTimer(item: Item): void {
    if (item.loadTimer !== undefined) clearTimeout(item.loadTimer);
    item.loadTimer = undefined;
  }

  private fade(
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
  private resumeFadeSettings(
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

  private resetFade(channel: Channel): void {
    channel.fadeTween?.cancel();
    channel.fadeTween = undefined;
    channel.fadeFactor = 1;
    this.applyGain(channel);
  }

  private duckTargetFor(channelNumber: number): number {
    const ducking = this.ducking;
    if (!ducking) return 1;
    const priority = this.channels.get(ducking.priorityChannel);
    if (!priority || priority.items.length === 0) return 1;
    return channelNumber === ducking.priorityChannel
      ? ducking.priorityVolume
      : ducking.duckingVolume;
  }

  private updateDucking(): void {
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

  private applyGain(channel: Channel): void {
    const head = channel.head;
    if (!head?.element) return;
    const gain = channel.effectiveGain(this.globalVolume);
    if (head.route) {
      this.webAudio.setGain(head.route, gain);
    } else {
      head.element.volume = gain;
    }
  }

  private anyPlaying(): boolean {
    for (const channel of this.channels.values()) {
      if (channel.head && !channel.paused) return true;
    }
    return false;
  }

  private hasBlockedItems(): boolean {
    for (const channel of this.channels.values()) {
      if (channel.head?.blocked === true) return true;
    }
    return false;
  }

  private readonly onUserGesture = (): void => this.unlockAudio();

  private armUnlock(): void {
    if (this.unlockArmed || typeof document === 'undefined') return;
    this.unlockArmed = true;
    UNLOCK_EVENTS.forEach((type) =>
      document.addEventListener(type, this.onUserGesture, { capture: true, passive: true })
    );
  }

  private disarmUnlock(): void {
    if (!this.unlockArmed || typeof document === 'undefined') return;
    this.unlockArmed = false;
    UNLOCK_EVENTS.forEach((type) =>
      document.removeEventListener(type, this.onUserGesture, { capture: true })
    );
  }

  private checkSlot(channel: Channel | undefined, slot: number, verb: string): string | undefined {
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

  private afterManipulation(channel: Channel, changed: boolean = true): QueueManipulationResult {
    if (changed) {
      this.emitQueueChange(channel);
      this.refresh(channel);
    }
    return { success: true, updatedQueue: this.snapshot(channel) };
  }

  private snapshot(channel: Channel): QueueSnapshot {
    return {
      channelNumber: channel.channelNumber,
      currentIndex: channel.items.length > 0 ? 0 : -1,
      isPaused: channel.paused,
      items: channel.describeItems(),
      totalItems: channel.items.length,
      volume: channel.volume
    };
  }

  private emptySnapshot(channelNumber: number): QueueSnapshot {
    return {
      channelNumber,
      currentIndex: -1,
      isPaused: false,
      items: [],
      totalItems: 0,
      volume: 1
    };
  }

  private describeHead(channel: Channel, item: Item): AudioInfo {
    const element = item.element;
    const duration = secondsToMs(element?.duration ?? NaN);
    const currentTime = secondsToMs(element?.currentTime ?? 0);
    const isPaused = channel.paused || (element?.paused ?? true);
    return {
      currentTime,
      duration,
      fileName: extractFileName(item.src),
      isLooping: item.loop,
      isPaused,
      isPlaying: !isPaused && item.started && !(element?.ended ?? false),
      progress: duration > 0 ? Math.min(1, currentTime / duration) : 0,
      remainingInQueue: Math.max(0, channel.items.length - 1),
      src: item.src,
      volume: channel.effectiveGain(this.globalVolume)
    };
  }

  private emitProgress(channel: Channel, item: Item): void {
    if (!this.emitter.has('progress', channel.channelNumber)) return;
    this.emitter.emit('progress', channel.channelNumber, this.describeHead(channel, item));
  }

  private emitQueueChange(channel: Channel): void {
    if (!this.emitter.has('queuechange', channel.channelNumber)) return;
    this.emitter.emit('queuechange', channel.channelNumber, this.snapshot(channel));
  }

  private emitComplete(channel: Channel, item: Item, reason: CompletionReason): void {
    this.emitter.emit('complete', channel.channelNumber, {
      channelNumber: channel.channelNumber,
      fileName: extractFileName(item.src),
      reason,
      remainingInQueue: channel.items.length,
      src: item.src
    });
  }

  private emitError(
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
      fileName: extractFileName(item.src),
      remainingInQueue: Math.max(0, remainingInQueue),
      src: item.src,
      timestamp: Date.now()
    });
  }
}

/**
 * Creates an independent audio queue. Use this when you need more than one queue on a page,
 * custom configuration, or isolated tests.
 * @param config - Configuration overrides
 * @returns A new AudioQueue
 * @example
 * ```typescript
 * const sfx = createAudioQueue({ defaultMaxQueueSize: 5, dropOldestWhenFull: true });
 * await sfx.queueAudio('/sfx/coin.mp3');
 * ```
 */
export const createAudioQueue = (config: Partial<QueueConfig> = {}): AudioQueue =>
  new AudioQueue(config);
