/**
 * @fileoverview audioq: queue audio files on independent channels with zero dependencies.
 *
 * Two ways to use it:
 * - Top-level functions (`queueAudio`, `pauseChannel`, ...) share one default queue.
 * - `createAudioQueue()` makes independent queues with their own configuration.
 */

export { AudioQueue, createAudioQueue } from './audio-queue.js';
export { getFadeConfig } from './config.js';
export * from './default-queue.js';
export { extractFileName } from './utils.js';
export { isIOSDevice, isWebAudioSupported } from './web-audio.js';

export { AudioErrorType, EasingType, FadeType, MAX_CHANNELS } from './types.js';
export type {
  AudioCompleteCallback,
  AudioCompleteInfo,
  AudioErrorCallback,
  AudioErrorInfo,
  AudioInfo,
  AudioPauseCallback,
  AudioQueueOptions,
  AudioResumeCallback,
  AudioStartCallback,
  AudioStartInfo,
  CompletionReason,
  FadeConfig,
  ItemOutcome,
  Logger,
  ProgressCallback,
  QueueChangeCallback,
  QueueConfig,
  QueueItem,
  QueueManipulationResult,
  QueueSnapshot,
  QueuedAudio,
  Unsubscribe,
  VolumeConfig,
  WebAudioMode,
  WebAudioSupport
} from './types.js';
