/**
 * @fileoverview The AudioQueue class: the public API. Independent channels, each playing its
 * queue in order. The machinery lives in QueueEngine (engine.ts).
 *
 * Design rules that keep it correct:
 * - Every queue mutation is synchronous, so no locks are needed.
 * - Every async callback (play() results, element events, timers) first checks that its item is
 *   still the current item and not yet released, so stale callbacks can never act.
 * - Items release their element, listeners, timers and Web Audio nodes exactly once (`finalize`).
 */

import { QueueEngine } from './engine.js';
import type { Item } from './channel.js';
import { getFadeConfig, mergeQueueConfig, validateVolumeConfig } from './config.js';
import { startTween } from './tween.js';
import {
  EasingType,
  FadeType,
  type AudioCompleteCallback,
  type AudioErrorCallback,
  type AudioInfo,
  type AudioPauseCallback,
  type AudioQueueOptions,
  type AudioResumeCallback,
  type AudioStartCallback,
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
import { assertChannelNumber, clampUnit } from './utils.js';
import { describeWebAudioSupport } from './web-audio.js';

/**
 * Manages audio channels, each with its own queue, volume, pause state and events.
 * Create one with {@link createAudioQueue}, or use the default instance through the package's
 * top-level functions.
 */
export class AudioQueue extends QueueEngine {
  /**
   * @param config - Configuration overrides; see {@link QueueConfig}
   */
  constructor(config: Partial<QueueConfig> = {}) {
    super(config);
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
    this.unlockBlocked();
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
