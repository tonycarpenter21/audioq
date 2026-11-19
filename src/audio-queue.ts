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
import {
  clampPlaybackRate,
  getFadeConfig,
  mergeQueueConfig,
  validateVolumeConfig
} from './config.js';
import { resolveUrl } from './media.js';
import { forgetMemory } from './memory.js';
import { startTween } from './tween.js';
import {
  EasingType,
  FadeType,
  type AudioCompleteCallback,
  type AudioCueCallback,
  type AudioErrorCallback,
  type AudioInfo,
  type AudioPauseCallback,
  type AudioQueueOptions,
  type AudioResumeCallback,
  type AudioSource,
  type AudioStartCallback,
  type HistoryEntry,
  type ProgressCallback,
  type QueueChangeCallback,
  type QueueConfig,
  type QueueItem,
  type QueueManipulationResult,
  type QueueSnapshot,
  type QueuedAudio,
  type RepeatMode,
  type Unsubscribe,
  type VolumeConfig,
  type WebAudioSupport
} from './types.js';
import { assertChannelNumber, clampUnit, secondsToMs } from './utils.js';
import { describeWebAudioSupport } from './web-audio.js';

/**
 * Validates a source and checks that audio can be played here.
 * @param source - URL or Blob passed to queueAudio
 * @returns The resolved URL for string sources, or undefined for a Blob
 */
const checkSource = (source: AudioSource): string | undefined => {
  const isBlob = typeof Blob !== 'undefined' && source instanceof Blob;
  if (!isBlob && (typeof source !== 'string' || source.trim().length === 0)) {
    throw new TypeError('source must be a non-empty URL string or a Blob');
  }
  if (typeof Audio === 'undefined') {
    throw new Error('audioq needs a browser environment (HTMLAudioElement is not available)');
  }
  return isBlob ? undefined : resolveUrl((source as string).trim());
};

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
    this.syncVisibilityListener();
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
   * Adds audio to a channel. If the channel is idle it starts playing right away.
   * Resolves as soon as the item is queued; use the returned handle to await start or finish.
   * @param source - URL of the file (relative, absolute, blob: or data:), or a Blob/File such as
   * a fetched or generated (text-to-speech) clip; Blob URLs are created and revoked for you
   * @param channelNumber - Channel to queue on (defaults to 0)
   * @param options - Per-item options
   * @returns Handle with `started` and `finished` promises
   * @example
   * ```typescript
   * const item = await queueAudio('/sfx/click.mp3');
   * await item.finished; // 'ended' | 'stopped' | 'error' | 'removed' | 'skipped'
   * await queueAudio('/music/theme.mp3', 1, { loop: true, volume: 0.5 });
   * ```
   */
  async queueAudio(
    source: AudioSource,
    channelNumber: number = 0,
    options: AudioQueueOptions = {}
  ): Promise<QueuedAudio> {
    const url = checkSource(source);
    if (options.maxQueueSize !== undefined && !(options.maxQueueSize >= 1)) {
      throw new RangeError('maxQueueSize must be at least 1');
    }
    const isNew = !this.channels.has(channelNumber);
    const channel = this.channel(channelNumber);
    try {
      return this.enqueue(channel, source, url, options);
    } catch (error) {
      // A rejected call must not leave an empty channel behind.
      if (isNew && channel.items.length === 0) this.channels.delete(channelNumber);
      throw error;
    }
  }

  /**
   * Adds audio right after the currently playing item.
   * @param source - URL of the file, or a Blob/File
   * @param channelNumber - Channel to queue on (defaults to 0)
   * @param options - Per-item options
   * @returns Handle with `started` and `finished` promises
   */
  async queueAudioPriority(
    source: AudioSource,
    channelNumber: number = 0,
    options: AudioQueueOptions = {}
  ): Promise<QueuedAudio> {
    return this.queueAudio(source, channelNumber, { ...options, addToFront: true });
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
    if (channel) this.clearChannel(channel);
  }

  /** Stops and clears every channel. */
  async stopAllAudio(): Promise<void> {
    // Synchronous on purpose: audio queued right after an un-awaited call must survive.
    this.channels.forEach((channel) => this.clearChannel(channel));
  }

  /**
   * Stops a channel, removes its listeners and forgets its settings.
   * @param channelNumber - Channel (defaults to 0)
   */
  async destroyChannel(channelNumber: number = 0): Promise<void> {
    this.destroyNow(channelNumber);
  }

  /**
   * Destroys every channel, removes all listeners, resets global volume, muting and ducking, releases
   * preloaded files, and closes the shared AudioContext. The queue can still be used afterwards.
   */
  async destroyAllChannels(): Promise<void> {
    // Synchronous on purpose (React effect cleanups do not await): anything queued or subscribed
    // right after this call belongs to the fresh state.
    [...this.channels.keys()].forEach((channelNumber) => this.destroyNow(channelNumber));
    this.emitter.clear();
    this.ducking = undefined;
    this.globalVolume = 1;
    this.globalMuted = false;
    this.disarmUnlock();
    this.webAudio.close();
    forgetMemory(this);
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
    if (problem !== undefined || !channel) {
      return { error: problem ?? 'Channel does not exist', success: false };
    }
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
    if (problem !== undefined || !channel) {
      return { error: problem ?? 'Channel does not exist', success: false };
    }
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
    if (problem !== undefined || !channel) {
      return { error: problem ?? 'Channel does not exist', success: false };
    }
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
    if (channel) this.pauseNow(channel);
  }

  /**
   * Resumes a paused channel. Resolves once the browser has accepted or refused playback.
   * @param channelNumber - Channel (defaults to 0)
   */
  async resumeChannel(channelNumber: number = 0): Promise<void> {
    const channel = this.existing(channelNumber);
    if (channel) await this.resumeNow(channel);
  }

  /**
   * Pauses a playing channel or resumes a paused one.
   * @param channelNumber - Channel (defaults to 0)
   */
  async togglePauseChannel(channelNumber: number = 0): Promise<void> {
    if (this.isPausedOrPausing(channelNumber)) {
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
    channel.pendingPause = true;
    const completed = await this.fade(channel, 0, duration ?? preset.duration, preset.pauseCurve);
    // Every path that cancels the pause (resume, pause, stop, track change) cancels the fade too.
    if (completed) this.pauseNow(channel);
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
    if (!channel.paused && !channel.pendingPause) return;
    const { curve, length } = this.resumeFadeSettings(channel, fadeType, duration);
    channel.pendingPause = false;
    channel.fadeTween?.cancel();
    if (channel.paused) {
      channel.fadeFactor = 0;
      channel.paused = false;
      channel.hiddenPause = false;
      if (channel.gapTimer === undefined) void this.play(channel, head);
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
    if (this.isPausedOrPausing(channelNumber)) {
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
   * Mutes or unmutes everything. Volumes are kept, so unmuting restores them exactly, and audio
   * keeps playing (muting is not pausing).
   * @param muted - Whether to mute
   * @example
   * ```ts
   * muteButton.onclick = () => setMuted(!isMuted());
   * ```
   */
  setMuted(muted: boolean): void {
    this.globalMuted = muted;
    this.applyMute(this.channels.values());
  }

  /**
   * Whether everything is muted with `setMuted`.
   * @returns True when muted
   */
  isMuted(): boolean {
    return this.globalMuted;
  }

  /**
   * Mutes or unmutes one channel, keeping its volume.
   * @param channelNumber - Channel
   * @param muted - Whether to mute
   */
  setChannelMuted(channelNumber: number, muted: boolean): void {
    const channel = this.channel(channelNumber);
    channel.muted = muted;
    this.applyMute([channel]);
  }

  /**
   * Whether a channel is muted with `setChannelMuted` (global muting is reported by `isMuted`).
   * @param channelNumber - Channel (defaults to 0)
   * @returns True when the channel is muted
   */
  isChannelMuted(channelNumber: number = 0): boolean {
    return this.existing(channelNumber)?.muted ?? false;
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
    const previous = this.ducking;
    this.ducking = undefined;
    this.updateDucking(previous);
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

  // ---------------------------------------------------------------- playback controls

  /**
   * Jumps to a position in the current item.
   * @param channelNumber - Channel
   * @param positionMs - Position in milliseconds (clamped to the item's length)
   * @returns True when there was an item to seek
   */
  seekTo(channelNumber: number, positionMs: number): boolean {
    const element = this.existing(channelNumber)?.head?.element;
    if (!element || !Number.isFinite(positionMs)) return false;
    const durationMs = secondsToMs(element.duration);
    const target = Math.max(0, durationMs > 0 ? Math.min(positionMs, durationMs) : positionMs);
    element.currentTime = target / 1000;
    return true;
  }

  /**
   * Moves forward (positive) or back (negative) in the current item, like a 15-second skip.
   * @param channelNumber - Channel
   * @param offsetMs - Milliseconds to move
   * @returns True when there was an item to seek
   */
  seekBy(channelNumber: number, offsetMs: number): boolean {
    const element = this.existing(channelNumber)?.head?.element;
    if (!element || !Number.isFinite(offsetMs)) return false;
    return this.seekTo(channelNumber, secondsToMs(element.currentTime) + offsetMs);
  }

  /**
   * Sets the playback speed of a channel (0.25-4, pitch preserved). Multiplies each item's own
   * `playbackRate`.
   * @param channelNumber - Channel
   * @param rate - Speed, for example 1.5
   */
  setPlaybackRate(channelNumber: number, rate: number): void {
    const channel = this.channel(channelNumber);
    channel.playbackRate = clampPlaybackRate(rate);
    this.applyRate(channel);
  }

  /**
   * Reads the playback speed of a channel.
   * @param channelNumber - Channel (defaults to 0)
   * @returns The channel speed (1 for unused channels)
   */
  getPlaybackRate(channelNumber: number = 0): number {
    return this.existing(channelNumber)?.playbackRate ?? 1;
  }

  /**
   * Chooses what happens when an item ends: `'off'` moves on, `'one'` replays the item,
   * `'all'` moves the finished item to the end of the queue so the queue repeats.
   * @param channelNumber - Channel
   * @param mode - Repeat mode
   */
  setRepeatMode(channelNumber: number, mode: RepeatMode): void {
    if (!['off', 'one', 'all'].includes(mode)) {
      throw new RangeError('Repeat mode must be "off", "one" or "all"');
    }
    const channel = this.channel(channelNumber);
    channel.repeat = mode;
    if (channel.head?.started === true) this.trackPosition(channel, channel.head);
  }

  /**
   * Reads a channel's repeat mode.
   * @param channelNumber - Channel (defaults to 0)
   * @returns The repeat mode (`'off'` for unused channels)
   */
  getRepeatMode(channelNumber: number = 0): RepeatMode {
    return this.existing(channelNumber)?.repeat ?? 'off';
  }

  /**
   * Shuffles the waiting items of a channel. The current item keeps playing.
   * @param channelNumber - Channel (defaults to 0)
   * @param random - Random number source returning [0, 1), for reproducible shuffles
   * @returns Whether it worked, and the updated queue
   */
  async shuffleQueue(
    channelNumber: number = 0,
    random: () => number = Math.random
  ): Promise<QueueManipulationResult> {
    const channel = this.existing(channelNumber);
    if (!channel) return { success: true, updatedQueue: this.emptySnapshot(channelNumber) };
    const items = channel.items;
    for (let i = items.length - 1; i > 1; i--) {
      const j = 1 + Math.floor(random() * i);
      [items[i], items[j]] = [items[j] as Item, items[i] as Item];
    }
    return this.afterManipulation(channel, items.length > 2);
  }

  /**
   * Adds a pause between items on a channel.
   * @param channelNumber - Channel
   * @param gapMs - Silence between items in milliseconds (0 for none)
   */
  setChannelGap(channelNumber: number, gapMs: number): void {
    if (!Number.isFinite(gapMs) || gapMs < 0) {
      throw new RangeError('gapMs must be 0 or a positive number of milliseconds');
    }
    this.channel(channelNumber).gapMs = gapMs;
  }

  /**
   * Reads the pause between items on a channel.
   * @param channelNumber - Channel (defaults to 0)
   * @returns Gap in milliseconds
   */
  getChannelGap(channelNumber: number = 0): number {
    return this.existing(channelNumber)?.gapMs ?? 0;
  }

  /**
   * Overlaps consecutive items: near the end of each item the next one starts and fades in while
   * the current one fades out. Limited to half of an item's length; ignored for looping items and
   * with repeat mode `'one'`.
   * @param channelNumber - Channel
   * @param crossfadeMs - Overlap in milliseconds (0 turns crossfading off)
   */
  setCrossfade(channelNumber: number, crossfadeMs: number): void {
    if (!Number.isFinite(crossfadeMs) || crossfadeMs < 0) {
      throw new RangeError('crossfadeMs must be 0 or a positive number of milliseconds');
    }
    const channel = this.channel(channelNumber);
    channel.crossfadeMs = crossfadeMs;
    if (channel.head?.started === true) this.trackPosition(channel, channel.head);
  }

  /**
   * Reads a channel's crossfade length.
   * @param channelNumber - Channel (defaults to 0)
   * @returns Overlap in milliseconds (0 when off)
   */
  getCrossfade(channelNumber: number = 0): number {
    return this.existing(channelNumber)?.crossfadeMs ?? 0;
  }

  /**
   * Lists the items that finished on a channel, oldest first (up to `historySize`).
   * @param channelNumber - Channel (defaults to 0)
   * @returns A copy of the history
   */
  getHistory(channelNumber: number = 0): HistoryEntry[] {
    return [...(this.existing(channelNumber)?.history ?? [])];
  }

  /**
   * Forgets a channel's history.
   * @param channelNumber - Channel (defaults to 0)
   */
  clearHistory(channelNumber: number = 0): void {
    this.existing(channelNumber)?.history.splice(0);
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
   * Listens for cues (from the `cues` item option) being entered and left: show a caption when
   * `active` is true, hide it when false. Point cues (no `endMs`) only fire when entered.
   * @param channelNumber - Channel
   * @param callback - Listener
   * @returns Function that removes this listener
   */
  onAudioCue(channelNumber: number, callback: AudioCueCallback): Unsubscribe {
    return this.subscribe('cue', channelNumber, callback);
  }

  /**
   * Removes cue listeners.
   * @param channelNumber - Channel (defaults to 0)
   * @param callback - Remove only this listener; omit to remove all on the channel
   */
  offAudioCue(channelNumber: number = 0, callback?: AudioCueCallback): void {
    this.emitter.off('cue', channelNumber, callback);
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
