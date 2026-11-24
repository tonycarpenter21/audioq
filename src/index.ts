/**
 * @fileoverview audioq: queue audio files on independent channels with zero dependencies.
 *
 * Two ways to use it:
 * - Top-level functions (`queueAudio`, `pauseChannel`, ...) share one default queue.
 * - `createAudioQueue()` makes independent queues with their own configuration.
 */

export { createAudioQueue } from './queue.js';
export type { AudioQueue } from './queue.js';
export { PLAYBACK_RATE_RANGE, getFadeConfig } from './config.js';
export * from './default-queue.js';
export { connectMediaSession } from './media-session.js';
export type { MediaSessionOptions } from './media-session.js';
export { defineSprite } from './sprite.js';
export { createChannelStore } from './store.js';
export { isAudioPreloaded, preloadAudio, releasePreloadedAudio } from './preload.js';
export type { ChannelState, ChannelStateListener, ChannelStore } from './store.js';
export { parseVttTimestamp, parseWebVtt } from './webvtt.js';
export type { AudioSprite, SpriteMap, SpriteSegment } from './sprite.js';
export { extractFileName } from './utils.js';
export { isIOSDevice, isWebAudioSupported } from './web-audio.js';

export { AudioErrorType, EasingType, FadeType, MAX_CHANNELS } from './types.js';
export type {
  AudioCompleteCallback,
  AudioCompleteInfo,
  AudioCue,
  AudioCueCallback,
  AudioCueInfo,
  AudioErrorCallback,
  AudioErrorInfo,
  AudioInfo,
  AudioPauseCallback,
  AudioArtwork,
  AudioMetadata,
  AudioQueueOptions,
  AudioSource,
  AudioResumeCallback,
  AudioStartCallback,
  AudioStartInfo,
  CompletionReason,
  FadeConfig,
  HistoryEntry,
  ItemOutcome,
  PreloadResult,
  Logger,
  ProgressCallback,
  QueueChangeCallback,
  QueueConfig,
  QueueItem,
  QueueManipulationResult,
  QueueSnapshot,
  QueuedAudio,
  RepeatMode,
  Unsubscribe,
  VolumeConfig,
  WebAudioMode,
  WebAudioSupport
} from './types.js';
