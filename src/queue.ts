/**
 * @fileoverview The 'audioq/queue' entry point: createAudioQueue() and one function per queue
 * operation, each taking the queue as its first argument. A queue is opaque to callers; the
 * machinery behind it lives in QueueEngine (engine.ts). Functions you never import are dropped
 * by your bundler.
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
import { assertChannelNumber, clampUnit } from './utils.js';
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
declare const audioQueueBrand: unique symbol;

/**
 * A queue made with {@link createAudioQueue}: its own channels, listeners and configuration. Pass
 * it as the first argument to the functions exported from 'audioq/queue'. The top-level functions
 * of 'audioq' use a shared default queue instead.
 */
export interface AudioQueue {
  readonly [audioQueueBrand]: true;
}

/** The engine behind a queue (a queue is an engine, typed opaquely for users). */
const engineOf = (queue: AudioQueue): QueueEngine => queue as unknown as QueueEngine;

/**
 * Updates the configuration. Changes apply to future operations.
 * @param queue - Queue made with createAudioQueue()
 * @param config - Settings to change
 * @example
 * ```typescript
 * setQueueConfig(queue, { defaultMaxQueueSize: 20, dropOldestWhenFull: true });
 * ```
 */
export function setQueueConfig(queue: AudioQueue, config: Partial<QueueConfig>): void {
  const engine = engineOf(queue);
  engine.config = mergeQueueConfig(engine.config, config);
  engine.syncVisibilityListener();
}

/**
 * Returns the current configuration.
 * @param queue - Queue made with createAudioQueue()
 * @returns A copy of the configuration
 */
export function getQueueConfig(queue: AudioQueue): QueueConfig {
  const engine = engineOf(queue);
  return { ...engine.config };
}

/**
 * Sets the queue limit for one channel (including the playing item).
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel to configure
 * @param maxSize - Maximum items, or undefined to fall back to `defaultMaxQueueSize`
 */
export function setChannelQueueLimit(
  queue: AudioQueue,
  channelNumber: number,
  maxSize?: number
): void {
  const engine = engineOf(queue);
  if (maxSize !== undefined && !(maxSize >= 1)) {
    throw new RangeError('maxSize must be at least 1');
  }
  engine.channel(channelNumber).maxQueueSize = maxSize;
}

/**
 * Describes whether Web Audio is available and used for new items.
 * @param queue - Queue made with createAudioQueue()
 * @returns Web Audio support information
 */
export function getWebAudioSupport(queue: AudioQueue): WebAudioSupport {
  const engine = engineOf(queue);
  return describeWebAudioSupport(engine.config.webAudio);
}

/**
 * Adds audio to a channel. If the channel is idle it starts playing right away.
 * Resolves as soon as the item is queued; use the returned handle to await start or finish.
 * @param queue - Queue made with createAudioQueue()
 * @param source - URL of the file (relative, absolute, blob: or data:), or a Blob/File such as
 * a fetched or generated (text-to-speech) clip; Blob URLs are created and revoked for you
 * @param channelNumber - Channel to queue on (defaults to 0)
 * @param options - Per-item options
 * @returns Handle with `started` and `finished` promises
 * @example
 * ```typescript
 * const item = await queueAudio(queue, '/sfx/click.mp3');
 * await item.finished; // 'ended' | 'stopped' | 'error' | 'removed' | 'skipped'
 * await queueAudio(queue, '/music/theme.mp3', 1, { loop: true, volume: 0.5 });
 * ```
 */
export async function queueAudio(
  queue: AudioQueue,
  source: AudioSource,
  channelNumber: number = 0,
  options: AudioQueueOptions = {}
): Promise<QueuedAudio> {
  const engine = engineOf(queue);
  const url = checkSource(source);
  if (options.maxQueueSize !== undefined && !(options.maxQueueSize >= 1)) {
    throw new RangeError('maxQueueSize must be at least 1');
  }
  const isNew = !engine.channels.has(channelNumber);
  const channel = engine.channel(channelNumber);
  try {
    return engine.enqueue(channel, source, url, options);
  } catch (error) {
    // A rejected call must not leave an empty channel behind.
    if (isNew && channel.items.length === 0) engine.channels.delete(channelNumber);
    throw error;
  }
}

/**
 * Adds audio right after the currently playing item.
 * @param queue - Queue made with createAudioQueue()
 * @param source - URL of the file, or a Blob/File
 * @param channelNumber - Channel to queue on (defaults to 0)
 * @param options - Per-item options
 * @returns Handle with `started` and `finished` promises
 */
export async function queueAudioPriority(
  queue: AudioQueue,
  source: AudioSource,
  channelNumber: number = 0,
  options: AudioQueueOptions = {}
): Promise<QueuedAudio> {
  return queueAudio(queue, source, channelNumber, { ...options, addToFront: true });
}

/**
 * Stops the current item and starts the next one.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 */
export async function stopCurrentAudioInChannel(
  queue: AudioQueue,
  channelNumber: number = 0
): Promise<void> {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  if (channel?.head) engine.advance(channel, 'stopped');
}

/**
 * Stops the current item and removes everything queued on the channel.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 */
export async function stopAllAudioInChannel(
  queue: AudioQueue,
  channelNumber: number = 0
): Promise<void> {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  if (channel) engine.clearChannel(channel);
}

/**
 * Stops and clears every channel.
 * @param queue - Queue made with createAudioQueue()
 */
export async function stopAllAudio(queue: AudioQueue): Promise<void> {
  const engine = engineOf(queue);
  // Synchronous on purpose: audio queued right after an un-awaited call must survive.
  engine.channels.forEach((channel) => engine.clearChannel(channel));
}

/**
 * Stops a channel, removes its listeners and forgets its settings.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 */
export async function destroyChannel(queue: AudioQueue, channelNumber: number = 0): Promise<void> {
  const engine = engineOf(queue);
  engine.destroyNow(channelNumber);
}

/**
 * Destroys every channel, removes all listeners, resets global volume, muting and ducking, releases
 * preloaded files, and closes the shared AudioContext. The queue can still be used afterwards.
 * @param queue - Queue made with createAudioQueue()
 */
export async function destroyAllChannels(queue: AudioQueue): Promise<void> {
  const engine = engineOf(queue);
  // Synchronous on purpose (React effect cleanups do not await): anything queued or subscribed
  // right after this call belongs to the fresh state.
  [...engine.channels.keys()].forEach((channelNumber) => engine.destroyNow(channelNumber));
  engine.emitter.clear();
  engine.ducking = undefined;
  engine.globalVolume = 1;
  engine.globalMuted = false;
  engine.disarmUnlock();
  engine.webAudio.close();
  engine.spareElements = [];
  forgetMemory(engine);
}

/**
 * Removes a waiting item. The current item (index 0) cannot be removed; stop it instead.
 * @param queue - Queue made with createAudioQueue()
 * @param queuedSlotNumber - Index of the item (1 or more)
 * @param channelNumber - Channel (defaults to 0)
 * @returns Whether it worked, and the updated queue
 */
export async function removeQueuedItem(
  queue: AudioQueue,
  queuedSlotNumber: number,
  channelNumber: number = 0
): Promise<QueueManipulationResult> {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  const problem = engine.checkSlot(channel, queuedSlotNumber, 'remove');
  if (problem !== undefined || !channel) {
    return { error: problem ?? 'Channel does not exist', success: false };
  }
  const [item] = channel.items.splice(queuedSlotNumber, 1);
  if (item) engine.finalize(item, 'removed');
  return engine.afterManipulation(channel);
}

/**
 * Moves a waiting item to another waiting position.
 * @param queue - Queue made with createAudioQueue()
 * @param currentQueuedSlotNumber - Current index (1 or more)
 * @param newQueuedSlotNumber - New index (1 or more)
 * @param channelNumber - Channel (defaults to 0)
 * @returns Whether it worked, and the updated queue
 */
export async function reorderQueue(
  queue: AudioQueue,
  currentQueuedSlotNumber: number,
  newQueuedSlotNumber: number,
  channelNumber: number = 0
): Promise<QueueManipulationResult> {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  const problem =
    engine.checkSlot(channel, currentQueuedSlotNumber, 'move') ??
    engine.checkSlot(channel, newQueuedSlotNumber, 'move to');
  if (problem !== undefined || !channel) {
    return { error: problem ?? 'Channel does not exist', success: false };
  }
  const [item] = channel.items.splice(currentQueuedSlotNumber, 1);
  if (item) channel.items.splice(newQueuedSlotNumber, 0, item);
  return engine.afterManipulation(channel, currentQueuedSlotNumber !== newQueuedSlotNumber);
}

/**
 * Swaps two waiting items.
 * @param queue - Queue made with createAudioQueue()
 * @param slotA - Index of the first item (1 or more)
 * @param slotB - Index of the second item (1 or more)
 * @param channelNumber - Channel (defaults to 0)
 * @returns Whether it worked, and the updated queue
 */
export async function swapQueueItems(
  queue: AudioQueue,
  slotA: number,
  slotB: number,
  channelNumber: number = 0
): Promise<QueueManipulationResult> {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  const problem =
    engine.checkSlot(channel, slotA, 'swap') ?? engine.checkSlot(channel, slotB, 'swap');
  if (problem !== undefined || !channel) {
    return { error: problem ?? 'Channel does not exist', success: false };
  }
  const a = channel.items[slotA] as Item;
  channel.items[slotA] = channel.items[slotB] as Item;
  channel.items[slotB] = a;
  return engine.afterManipulation(channel, slotA !== slotB);
}

/**
 * Removes every waiting item; the current item keeps playing.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @returns Whether it worked, and the updated queue
 */
export async function clearQueueAfterCurrent(
  queue: AudioQueue,
  channelNumber: number = 0
): Promise<QueueManipulationResult> {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  if (!channel) return { success: true, updatedQueue: engine.emptySnapshot(channelNumber) };
  const removed = channel.items.splice(1);
  removed.forEach((item) => engine.finalize(item, 'removed'));
  return engine.afterManipulation(channel, removed.length > 0);
}

/**
 * Describes one queued item.
 * @param queue - Queue made with createAudioQueue()
 * @param queueSlotNumber - Index of the item (0 is current)
 * @param channelNumber - Channel (defaults to 0)
 * @returns Item information, or null when the slot is empty
 */
export function getQueueItemInfo(
  queue: AudioQueue,
  queueSlotNumber: number,
  channelNumber: number = 0
): QueueItem | null {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  return channel?.describeItems()[queueSlotNumber] ?? null;
}

/**
 * Counts the items on a channel, including the current one.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @returns Number of items
 */
export function getQueueLength(queue: AudioQueue, channelNumber: number = 0): number {
  const engine = engineOf(queue);
  return engine.existing(channelNumber)?.items.length ?? 0;
}

/**
 * Pauses a channel.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 */
export async function pauseChannel(queue: AudioQueue, channelNumber: number = 0): Promise<void> {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  if (channel) engine.pauseNow(channel);
}

/**
 * Resumes a paused channel. Resolves once the browser has accepted or refused playback.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 */
export async function resumeChannel(queue: AudioQueue, channelNumber: number = 0): Promise<void> {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  if (channel) await engine.resumeNow(channel);
}

/**
 * Pauses a playing channel or resumes a paused one.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 */
export async function togglePauseChannel(
  queue: AudioQueue,
  channelNumber: number = 0
): Promise<void> {
  const engine = engineOf(queue);
  if (engine.isPausedOrPausing(channelNumber)) {
    await resumeChannel(queue, channelNumber);
  } else {
    await pauseChannel(queue, channelNumber);
  }
}

/**
 * Pauses every channel.
 * @param queue - Queue made with createAudioQueue()
 */
export async function pauseAllChannels(queue: AudioQueue): Promise<void> {
  const engine = engineOf(queue);
  await Promise.all([...engine.channels.keys()].map((n) => pauseChannel(queue, n)));
}

/**
 * Resumes every paused channel.
 * @param queue - Queue made with createAudioQueue()
 */
export async function resumeAllChannels(queue: AudioQueue): Promise<void> {
  const engine = engineOf(queue);
  await Promise.all([...engine.channels.keys()].map((n) => resumeChannel(queue, n)));
}

/**
 * Pauses everything if anything is playing, otherwise resumes everything.
 * @param queue - Queue made with createAudioQueue()
 */
export async function togglePauseAllChannels(queue: AudioQueue): Promise<void> {
  const engine = engineOf(queue);
  if (engine.anyPlaying()) await pauseAllChannels(queue);
  else await resumeAllChannels(queue);
}

/**
 * Fades a channel out, then pauses it. Calling a resume during the fade cancels the pause.
 * @param queue - Queue made with createAudioQueue()
 * @param fadeType - Fade preset (defaults to Gentle)
 * @param channelNumber - Channel (defaults to 0)
 * @param duration - Fade length in ms (defaults to the preset's duration)
 */
export async function pauseWithFade(
  queue: AudioQueue,
  fadeType: FadeType = FadeType.Gentle,
  channelNumber: number = 0,
  duration?: number
): Promise<void> {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  if (!channel?.head || channel.paused) return;
  const preset = getFadeConfig(fadeType);
  channel.lastFade = { duration, fadeType };
  channel.pendingPause = true;
  const completed = await engine.fade(channel, 0, duration ?? preset.duration, preset.pauseCurve);
  // Every path that cancels the pause (resume, pause, stop, track change) cancels the fade too.
  if (completed) engine.pauseNow(channel);
}

/**
 * Resumes a channel and fades it in. Also cancels a fade-out that is still running.
 * @param queue - Queue made with createAudioQueue()
 * @param fadeType - Fade preset (defaults to the one used to pause)
 * @param channelNumber - Channel (defaults to 0)
 * @param duration - Fade length in ms (defaults to the pause fade's length)
 */
export async function resumeWithFade(
  queue: AudioQueue,
  fadeType?: FadeType,
  channelNumber: number = 0,
  duration?: number
): Promise<void> {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  const head = channel?.head;
  if (!channel || !head) return;
  if (!channel.paused && !channel.pendingPause) return;
  const { curve, length } = engine.resumeFadeSettings(channel, fadeType, duration);
  channel.pendingPause = false;
  channel.fadeTween?.cancel();
  if (channel.paused) {
    channel.fadeFactor = 0;
    channel.paused = false;
    channel.hiddenPause = false;
    if (channel.gapTimer === undefined) void engine.play(channel, head);
    engine.emitter.emit('resume', channel.channelNumber, engine.describeHead(channel, head));
  }
  await engine.fade(channel, 1, length, curve);
}

/**
 * Fades out and pauses a playing channel, or resumes and fades in a paused one.
 * @param queue - Queue made with createAudioQueue()
 * @param fadeType - Fade preset used when pausing (defaults to Gentle)
 * @param channelNumber - Channel (defaults to 0)
 * @param duration - Fade length in ms
 */
export async function togglePauseWithFade(
  queue: AudioQueue,
  fadeType: FadeType = FadeType.Gentle,
  channelNumber: number = 0,
  duration?: number
): Promise<void> {
  const engine = engineOf(queue);
  if (engine.isPausedOrPausing(channelNumber)) {
    await resumeWithFade(queue, undefined, channelNumber, duration);
  } else {
    await pauseWithFade(queue, fadeType, channelNumber, duration);
  }
}

/**
 * Fades out and pauses every channel.
 * @param queue - Queue made with createAudioQueue()
 * @param fadeType - Fade preset (defaults to Gentle)
 * @param duration - Fade length in ms
 */
export async function pauseAllWithFade(
  queue: AudioQueue,
  fadeType: FadeType = FadeType.Gentle,
  duration?: number
): Promise<void> {
  const engine = engineOf(queue);
  await Promise.all(
    [...engine.channels.keys()].map((n) => pauseWithFade(queue, fadeType, n, duration))
  );
}

/**
 * Resumes and fades in every paused channel.
 * @param queue - Queue made with createAudioQueue()
 * @param fadeType - Fade preset (defaults to each channel's pause preset)
 * @param duration - Fade length in ms
 */
export async function resumeAllWithFade(
  queue: AudioQueue,
  fadeType?: FadeType,
  duration?: number
): Promise<void> {
  const engine = engineOf(queue);
  await Promise.all(
    [...engine.channels.keys()].map((n) => resumeWithFade(queue, fadeType, n, duration))
  );
}

/**
 * Fades everything out if anything is playing, otherwise fades everything back in.
 * @param queue - Queue made with createAudioQueue()
 * @param fadeType - Fade preset (defaults to Gentle)
 * @param duration - Fade length in ms
 */
export async function togglePauseAllWithFade(
  queue: AudioQueue,
  fadeType: FadeType = FadeType.Gentle,
  duration?: number
): Promise<void> {
  const engine = engineOf(queue);
  if (engine.anyPlaying()) await pauseAllWithFade(queue, fadeType, duration);
  else await resumeAllWithFade(queue, fadeType, duration);
}

/**
 * Whether a channel is paused.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @returns True when paused
 */
export function isChannelPaused(queue: AudioQueue, channelNumber: number = 0): boolean {
  const engine = engineOf(queue);
  return engine.existing(channelNumber)?.paused ?? false;
}

/**
 * Pause state of every channel, indexed by channel number.
 * @param queue - Queue made with createAudioQueue()
 * @returns One boolean per channel up to the highest channel used
 */
export function getAllChannelsPauseState(queue: AudioQueue): boolean[] {
  const engine = engineOf(queue);
  return engine.perChannel((channel) => channel?.paused ?? false);
}

/**
 * Sets a channel's volume, optionally with a transition. Works on idle channels too.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param volume - Volume (0-1)
 * @param transitionDuration - Transition length in ms (instant when omitted or 0)
 * @param easing - Transition curve (defaults to ease-out)
 */
export async function setChannelVolume(
  queue: AudioQueue,
  channelNumber: number,
  volume: number,
  transitionDuration?: number,
  easing: EasingType = EasingType.EaseOut
): Promise<void> {
  const engine = engineOf(queue);
  const channel = engine.channel(channelNumber);
  const target = clampUnit(volume, channel.volume);
  channel.volumeTween?.cancel();
  const tween = startTween({
    duration: transitionDuration ?? 0,
    easing,
    from: channel.volume,
    onUpdate: (value) => {
      channel.volume = value;
      engine.applyGain(channel);
    },
    to: target
  });
  channel.volumeTween = tween;
  await tween.done;
  if (channel.volumeTween === tween) channel.volumeTween = undefined;
}

/**
 * Transitions a channel's volume over time.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param targetVolume - Volume to reach (0-1)
 * @param duration - Transition length in ms (defaults to 250)
 * @param easing - Transition curve (defaults to ease-out)
 */
export async function transitionVolume(
  queue: AudioQueue,
  channelNumber: number,
  targetVolume: number,
  duration: number = 250,
  easing: EasingType = EasingType.EaseOut
): Promise<void> {
  await setChannelVolume(queue, channelNumber, targetVolume, duration, easing);
}

/**
 * Stops a running volume transition where it is.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 */
export function cancelVolumeTransition(queue: AudioQueue, channelNumber: number): void {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  channel?.volumeTween?.cancel();
  if (channel) channel.volumeTween = undefined;
}

/**
 * Stops every running volume transition.
 * @param queue - Queue made with createAudioQueue()
 */
export function cancelAllVolumeTransitions(queue: AudioQueue): void {
  const engine = engineOf(queue);
  for (const channelNumber of engine.channels.keys()) cancelVolumeTransition(queue, channelNumber);
}

/**
 * Reads a channel's volume.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @returns Volume (0-1); 1 for unused channels
 */
export function getChannelVolume(queue: AudioQueue, channelNumber: number = 0): number {
  const engine = engineOf(queue);
  return engine.existing(channelNumber)?.volume ?? 1;
}

/**
 * Volumes of every channel, indexed by channel number.
 * @param queue - Queue made with createAudioQueue()
 * @returns One volume per channel up to the highest channel used
 */
export function getAllChannelsVolume(queue: AudioQueue): number[] {
  const engine = engineOf(queue);
  return engine.perChannel((channel) => channel?.volume ?? 1);
}

/**
 * Sets the same volume on every channel in use.
 * @param queue - Queue made with createAudioQueue()
 * @param volume - Volume (0-1)
 */
export async function setAllChannelsVolume(queue: AudioQueue, volume: number): Promise<void> {
  const engine = engineOf(queue);
  await Promise.all([...engine.channels.keys()].map((n) => setChannelVolume(queue, n, volume)));
}

/**
 * Sets the global volume, which multiplies every channel's volume.
 * @param queue - Queue made with createAudioQueue()
 * @param volume - Volume (0-1)
 */
export async function setGlobalVolume(queue: AudioQueue, volume: number): Promise<void> {
  const engine = engineOf(queue);
  engine.globalVolume = clampUnit(volume, engine.globalVolume);
  engine.channels.forEach((channel) => engine.applyGain(channel));
}

/**
 * Reads the global volume.
 * @param queue - Queue made with createAudioQueue()
 * @returns Global volume (0-1)
 */
export function getGlobalVolume(queue: AudioQueue): number {
  const engine = engineOf(queue);
  return engine.globalVolume;
}

/**
 * Mutes or unmutes everything. Volumes are kept, so unmuting restores them exactly, and audio
 * keeps playing (muting is not pausing).
 * @param queue - Queue made with createAudioQueue()
 * @param muted - Whether to mute
 * @example
 * ```ts
 * muteButton.onclick = () => setMuted(queue, !isMuted());
 * ```
 */
export function setMuted(queue: AudioQueue, muted: boolean): void {
  const engine = engineOf(queue);
  engine.globalMuted = muted;
  engine.applyMute(engine.channels.values());
}

/**
 * Whether everything is muted with `setMuted`.
 * @param queue - Queue made with createAudioQueue()
 * @returns True when muted
 */
export function isMuted(queue: AudioQueue): boolean {
  const engine = engineOf(queue);
  return engine.globalMuted;
}

/**
 * Mutes or unmutes one channel, keeping its volume.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param muted - Whether to mute
 */
export function setChannelMuted(queue: AudioQueue, channelNumber: number, muted: boolean): void {
  const engine = engineOf(queue);
  const channel = engine.channel(channelNumber);
  channel.muted = muted;
  engine.applyMute([channel]);
}

/**
 * Whether a channel is muted with `setChannelMuted` (global muting is reported by `isMuted`).
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @returns True when the channel is muted
 */
export function isChannelMuted(queue: AudioQueue, channelNumber: number = 0): boolean {
  const engine = engineOf(queue);
  return engine.existing(channelNumber)?.muted ?? false;
}

/**
 * Lowers every other channel while the priority channel has audio queued.
 * Channels that start during ducking are ducked too.
 * @param queue - Queue made with createAudioQueue()
 * @param config - Ducking settings
 */
export function setVolumeDucking(queue: AudioQueue, config: VolumeConfig): void {
  const engine = engineOf(queue);
  engine.ducking = validateVolumeConfig(config, engine.config.maxChannels);
  engine.updateDucking();
}

/**
 * Turns ducking off and restores every channel.
 * @param queue - Queue made with createAudioQueue()
 */
export function clearVolumeDucking(queue: AudioQueue): void {
  const engine = engineOf(queue);
  const previous = engine.ducking;
  engine.ducking = undefined;
  engine.updateDucking(previous);
}

/**
 * Describes the current item of a channel.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @returns Playback information, or null when nothing is queued
 */
export function getCurrentAudioInfo(
  queue: AudioQueue,
  channelNumber: number = 0
): AudioInfo | null {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  const head = channel?.head;
  return channel && head ? engine.describeHead(channel, head) : null;
}

/**
 * Describes the current item of every channel, indexed by channel number.
 * @param queue - Queue made with createAudioQueue()
 * @returns One entry per channel up to the highest channel used
 */
export function getAllChannelsInfo(queue: AudioQueue): (AudioInfo | null)[] {
  const engine = engineOf(queue);
  return engine.perChannel((channel) =>
    channel?.head ? engine.describeHead(channel, channel.head) : null
  );
}

/**
 * Describes a channel's whole queue.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @returns The snapshot, or null for a channel that was never used
 */
export function getQueueSnapshot(
  queue: AudioQueue,
  channelNumber: number = 0
): QueueSnapshot | null {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  return channel ? engine.snapshot(channel) : null;
}

/**
 * Calls `unlockAudio` from your own click or key handler to start sounds the browser blocked.
 * audioq also does this automatically on the next pointer or key press.
 * @param queue - Queue made with createAudioQueue()
 */
export function unlockAudio(queue: AudioQueue): void {
  const engine = engineOf(queue);
  engine.unlockBlocked();
}

/**
 * Jumps to a position in the current item.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param positionMs - Position in milliseconds (clamped to the item's length)
 * @returns True when there was an item to seek
 */
export function seekTo(queue: AudioQueue, channelNumber: number, positionMs: number): boolean {
  const engine = engineOf(queue);
  const head = engine.existing(channelNumber)?.head;
  if (!head?.element || !Number.isFinite(positionMs)) return false;
  engine.seekItem(head, positionMs);
  return true;
}

/**
 * Moves forward (positive) or back (negative) in the current item, like a 15-second skip.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param offsetMs - Milliseconds to move
 * @returns True when there was an item to seek
 */
export function seekBy(queue: AudioQueue, channelNumber: number, offsetMs: number): boolean {
  const engine = engineOf(queue);
  const head = engine.existing(channelNumber)?.head;
  if (!head?.element || !Number.isFinite(offsetMs)) return false;
  return seekTo(queue, channelNumber, engine.positionOf(head) + offsetMs);
}

/**
 * Sets the playback speed of a channel (0.25-4, pitch preserved). Multiplies each item's own
 * `playbackRate`.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param rate - Speed, for example 1.5
 */
export function setPlaybackRate(queue: AudioQueue, channelNumber: number, rate: number): void {
  const engine = engineOf(queue);
  const channel = engine.channel(channelNumber);
  channel.playbackRate = clampPlaybackRate(rate);
  engine.applyRate(channel);
}

/**
 * Reads the playback speed of a channel.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @returns The channel speed (1 for unused channels)
 */
export function getPlaybackRate(queue: AudioQueue, channelNumber: number = 0): number {
  const engine = engineOf(queue);
  return engine.existing(channelNumber)?.playbackRate ?? 1;
}

/**
 * Chooses what happens when an item ends: `'off'` moves on, `'one'` replays the item,
 * `'all'` moves the finished item to the end of the queue so the queue repeats.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param mode - Repeat mode
 */
export function setRepeatMode(queue: AudioQueue, channelNumber: number, mode: RepeatMode): void {
  const engine = engineOf(queue);
  if (!['off', 'one', 'all'].includes(mode)) {
    throw new RangeError('Repeat mode must be "off", "one" or "all"');
  }
  const channel = engine.channel(channelNumber);
  channel.repeat = mode;
  if (channel.head?.started === true) engine.trackPosition(channel, channel.head);
}

/**
 * Reads a channel's repeat mode.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @returns The repeat mode (`'off'` for unused channels)
 */
export function getRepeatMode(queue: AudioQueue, channelNumber: number = 0): RepeatMode {
  const engine = engineOf(queue);
  return engine.existing(channelNumber)?.repeat ?? 'off';
}

/**
 * Shuffles the waiting items of a channel. The current item keeps playing.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @param random - Random number source returning [0, 1), for reproducible shuffles
 * @returns Whether it worked, and the updated queue
 */
export async function shuffleQueue(
  queue: AudioQueue,
  channelNumber: number = 0,
  random: () => number = Math.random
): Promise<QueueManipulationResult> {
  const engine = engineOf(queue);
  const channel = engine.existing(channelNumber);
  if (!channel) return { success: true, updatedQueue: engine.emptySnapshot(channelNumber) };
  const items = channel.items;
  for (let i = items.length - 1; i > 1; i--) {
    const j = 1 + Math.floor(random() * i);
    [items[i], items[j]] = [items[j] as Item, items[i] as Item];
  }
  return engine.afterManipulation(channel, items.length > 2);
}

/**
 * Adds a pause between items on a channel.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param gapMs - Silence between items in milliseconds (0 for none)
 */
export function setChannelGap(queue: AudioQueue, channelNumber: number, gapMs: number): void {
  const engine = engineOf(queue);
  if (!Number.isFinite(gapMs) || gapMs < 0) {
    throw new RangeError('gapMs must be 0 or a positive number of milliseconds');
  }
  engine.channel(channelNumber).gapMs = gapMs;
}

/**
 * Reads the pause between items on a channel.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @returns Gap in milliseconds
 */
export function getChannelGap(queue: AudioQueue, channelNumber: number = 0): number {
  const engine = engineOf(queue);
  return engine.existing(channelNumber)?.gapMs ?? 0;
}

/**
 * Places a channel in the stereo field, from -1 (left) through 0 (center) to 1 (right). Panning
 * routes the channel's audio through Web Audio, so it works for same-origin, preloaded or
 * CORS-enabled (`crossOrigin: 'anonymous'`) audio; other audio plays centered, with a warning.
 * Ignored when `webAudio` is `'off'` and in browsers without StereoPannerNode (Safari before
 * 14.1).
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param pan - Position (-1 to 1; values outside are clamped)
 * @example
 * ```ts
 * setChannelPan(queue, 1, -0.8); // footsteps on the left
 * ```
 */
export function setChannelPan(queue: AudioQueue, channelNumber: number, pan: number): void {
  const engine = engineOf(queue);
  if (!Number.isFinite(pan)) throw new RangeError('pan must be a number from -1 to 1');
  const channel = engine.channel(channelNumber);
  channel.pan = Math.min(1, Math.max(-1, pan));
  engine.applyWebAudio(channel);
}

/**
 * Reads a channel's stereo position.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @returns Position from -1 (left) to 1 (right); 0 is center
 */
export function getChannelPan(queue: AudioQueue, channelNumber: number = 0): number {
  const engine = engineOf(queue);
  return engine.existing(channelNumber)?.pan ?? 0;
}

/**
 * An AnalyserNode measuring what a channel plays (after volume, fades and panning), for
 * visualizers and level meters. Read it with the standard Web Audio methods
 * (`getByteFrequencyData`, `getByteTimeDomainData`) and tune it with `fftSize` and
 * `smoothingTimeConstant`. Calling it routes the channel through Web Audio, so it measures
 * same-origin, preloaded or CORS (`crossOrigin: 'anonymous'`) audio; other audio plays but reads
 * as silence. Returns the same node on every call.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @returns The analyser, or undefined when `webAudio` is `'off'` or Web Audio is unavailable
 * @example
 * ```ts
 * const analyser = getChannelAnalyser(queue, 0);
 * const bins = new Uint8Array(analyser?.frequencyBinCount ?? 0);
 * const draw = (): void => {
 *   analyser?.getByteFrequencyData(bins); // 0-255 per frequency band
 *   requestAnimationFrame(draw);
 * };
 * draw();
 * ```
 */
export function getChannelAnalyser(
  queue: AudioQueue,
  channelNumber: number
): AnalyserNode | undefined {
  const engine = engineOf(queue);
  if (engine.config.webAudio === 'off') return undefined;
  const channel = engine.channel(channelNumber);
  if (!channel.analyser) {
    channel.analyser = engine.webAudio.createAnalyser();
    if (!channel.analyser) return undefined;
    engine.applyWebAudio(channel);
  }
  return channel.analyser;
}

/**
 * Overlaps consecutive items: near the end of each item the next one starts and fades in while
 * the current one fades out. Limited to half of an item's length; ignored for looping items and
 * with repeat mode `'one'`.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param crossfadeMs - Overlap in milliseconds (0 turns crossfading off)
 */
export function setCrossfade(queue: AudioQueue, channelNumber: number, crossfadeMs: number): void {
  const engine = engineOf(queue);
  if (!Number.isFinite(crossfadeMs) || crossfadeMs < 0) {
    throw new RangeError('crossfadeMs must be 0 or a positive number of milliseconds');
  }
  const channel = engine.channel(channelNumber);
  channel.crossfadeMs = crossfadeMs;
  if (channel.head?.started === true) engine.trackPosition(channel, channel.head);
}

/**
 * Reads a channel's crossfade length.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @returns Overlap in milliseconds (0 when off)
 */
export function getCrossfade(queue: AudioQueue, channelNumber: number = 0): number {
  const engine = engineOf(queue);
  return engine.existing(channelNumber)?.crossfadeMs ?? 0;
}

/**
 * Lists the items that finished on a channel, oldest first (up to `historySize`).
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @returns A copy of the history
 */
export function getHistory(queue: AudioQueue, channelNumber: number = 0): HistoryEntry[] {
  const engine = engineOf(queue);
  return [...(engine.existing(channelNumber)?.history ?? [])];
}

/**
 * Forgets a channel's history.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 */
export function clearHistory(queue: AudioQueue, channelNumber: number = 0): void {
  const engine = engineOf(queue);
  engine.existing(channelNumber)?.history.splice(0);
}

/**
 * Listens for progress updates of a channel's current item.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param callback - Listener
 * @returns Function that removes this listener
 */
export function onAudioProgress(
  queue: AudioQueue,
  channelNumber: number,
  callback: ProgressCallback
): Unsubscribe {
  const engine = engineOf(queue);
  return engine.subscribe('progress', channelNumber, callback);
}

/**
 * Removes progress listeners.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @param callback - Remove only this listener; omit to remove all on the channel
 */
export function offAudioProgress(
  queue: AudioQueue,
  channelNumber: number = 0,
  callback?: ProgressCallback
): void {
  const engine = engineOf(queue);
  engine.emitter.off('progress', channelNumber, callback);
}

/**
 * Listens for queue changes on a channel.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param callback - Listener
 * @returns Function that removes this listener
 */
export function onQueueChange(
  queue: AudioQueue,
  channelNumber: number,
  callback: QueueChangeCallback
): Unsubscribe {
  const engine = engineOf(queue);
  return engine.subscribe('queuechange', channelNumber, callback);
}

/**
 * Removes queue change listeners.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @param callback - Remove only this listener; omit to remove all on the channel
 */
export function offQueueChange(
  queue: AudioQueue,
  channelNumber: number = 0,
  callback?: QueueChangeCallback
): void {
  const engine = engineOf(queue);
  engine.emitter.off('queuechange', channelNumber, callback);
}

/**
 * Listens for playback starts on a channel.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param callback - Listener
 * @returns Function that removes this listener
 */
export function onAudioStart(
  queue: AudioQueue,
  channelNumber: number,
  callback: AudioStartCallback
): Unsubscribe {
  const engine = engineOf(queue);
  return engine.subscribe('start', channelNumber, callback);
}

/**
 * Removes start listeners.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @param callback - Remove only this listener; omit to remove all on the channel
 */
export function offAudioStart(
  queue: AudioQueue,
  channelNumber: number = 0,
  callback?: AudioStartCallback
): void {
  const engine = engineOf(queue);
  engine.emitter.off('start', channelNumber, callback);
}

/**
 * Listens for items leaving the front of a channel (ended, stopped or failed).
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param callback - Listener
 * @returns Function that removes this listener
 */
export function onAudioComplete(
  queue: AudioQueue,
  channelNumber: number,
  callback: AudioCompleteCallback
): Unsubscribe {
  const engine = engineOf(queue);
  return engine.subscribe('complete', channelNumber, callback);
}

/**
 * Removes complete listeners.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @param callback - Remove only this listener; omit to remove all on the channel
 */
export function offAudioComplete(
  queue: AudioQueue,
  channelNumber: number = 0,
  callback?: AudioCompleteCallback
): void {
  const engine = engineOf(queue);
  engine.emitter.off('complete', channelNumber, callback);
}

/**
 * Listens for pauses on a channel.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param callback - Listener, called with the channel number and playback information
 * @returns Function that removes this listener
 */
export function onAudioPause(
  queue: AudioQueue,
  channelNumber: number,
  callback: AudioPauseCallback
): Unsubscribe {
  const engine = engineOf(queue);
  assertChannelNumber(channelNumber, engine.config.maxChannels);
  return engine.emitter.on(
    'pause',
    channelNumber,
    (info) => callback(channelNumber, info),
    callback
  );
}

/**
 * Removes pause listeners.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @param callback - Remove only this listener; omit to remove all on the channel
 */
export function offAudioPause(
  queue: AudioQueue,
  channelNumber: number = 0,
  callback?: AudioPauseCallback
): void {
  const engine = engineOf(queue);
  engine.emitter.off('pause', channelNumber, callback);
}

/**
 * Listens for resumes on a channel.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param callback - Listener, called with the channel number and playback information
 * @returns Function that removes this listener
 */
export function onAudioResume(
  queue: AudioQueue,
  channelNumber: number,
  callback: AudioResumeCallback
): Unsubscribe {
  const engine = engineOf(queue);
  assertChannelNumber(channelNumber, engine.config.maxChannels);
  return engine.emitter.on(
    'resume',
    channelNumber,
    (info) => callback(channelNumber, info),
    callback
  );
}

/**
 * Removes resume listeners.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @param callback - Remove only this listener; omit to remove all on the channel
 */
export function offAudioResume(
  queue: AudioQueue,
  channelNumber: number = 0,
  callback?: AudioResumeCallback
): void {
  const engine = engineOf(queue);
  engine.emitter.off('resume', channelNumber, callback);
}

/**
 * Listens for cues (from the `cues` item option) being entered and left: show a caption when
 * `active` is true, hide it when false. Point cues (no `endMs`) only fire when entered.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param callback - Listener
 * @returns Function that removes this listener
 */
export function onAudioCue(
  queue: AudioQueue,
  channelNumber: number,
  callback: AudioCueCallback
): Unsubscribe {
  const engine = engineOf(queue);
  return engine.subscribe('cue', channelNumber, callback);
}

/**
 * Removes cue listeners.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @param callback - Remove only this listener; omit to remove all on the channel
 */
export function offAudioCue(
  queue: AudioQueue,
  channelNumber: number = 0,
  callback?: AudioCueCallback
): void {
  const engine = engineOf(queue);
  engine.emitter.off('cue', channelNumber, callback);
}

/**
 * Listens for errors on a channel. Failed items are skipped automatically; a blocked autoplay
 * keeps the item and retries on the next user gesture.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel
 * @param callback - Listener
 * @returns Function that removes this listener
 */
export function onAudioError(
  queue: AudioQueue,
  channelNumber: number,
  callback: AudioErrorCallback
): Unsubscribe {
  const engine = engineOf(queue);
  return engine.subscribe('error', channelNumber, callback);
}

/**
 * Removes error listeners.
 * @param queue - Queue made with createAudioQueue()
 * @param channelNumber - Channel (defaults to 0)
 * @param callback - Remove only this listener; omit to remove all on the channel
 */
export function offAudioError(
  queue: AudioQueue,
  channelNumber: number = 0,
  callback?: AudioErrorCallback
): void {
  const engine = engineOf(queue);
  engine.emitter.off('error', channelNumber, callback);
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
  new QueueEngine(config) as unknown as AudioQueue;
