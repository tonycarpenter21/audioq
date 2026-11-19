/**
 * @fileoverview Public types, enums, and constants for audioq.
 */

/** Default maximum number of channels a queue accepts (channel numbers 0-63). */
export const MAX_CHANNELS: number = 64;

/** Categories of audio errors reported through `onAudioError`. */
export enum AudioErrorType {
  /** Loading was aborted by the browser. */
  Abort = 'abort',
  /** The browser refused to start playback until the user interacts with the page. */
  AutoplayBlocked = 'autoplay-blocked',
  /** The file was fetched but could not be decoded. */
  Decode = 'decode',
  /** The file could not be fetched. */
  Network = 'network',
  /** The file did not start playing within `loadTimeoutMs`. */
  Timeout = 'timeout',
  /** The error could not be categorized. */
  Unknown = 'unknown',
  /** The format or source is not supported by this browser. */
  Unsupported = 'unsupported'
}

/** Easing curves for volume transitions. */
export enum EasingType {
  /** Constant rate. */
  Linear = 'linear',
  /** Starts slow, ends fast. */
  EaseIn = 'ease-in',
  /** Starts fast, ends slow. */
  EaseOut = 'ease-out',
  /** Slow at both ends. */
  EaseInOut = 'ease-in-out'
}

/** Preset fades used by the `*WithFade` pause/resume functions. */
export enum FadeType {
  /** Linear fade in both directions. */
  Linear = 'linear',
  /** Soft fade: ease-out when pausing, ease-in when resuming. */
  Gentle = 'gentle',
  /** Sharp fade: ease-in when pausing, ease-out when resuming. */
  Dramatic = 'dramatic'
}

/** Why an item left the front of its channel. */
export type CompletionReason = 'ended' | 'stopped' | 'error';

/**
 * How an item's lifecycle finished: it left the front of its channel (`ended`, `stopped`,
 * `error`), was removed while waiting (`removed`), or was never queued because of `dedupeMs`
 * (`skipped`).
 */
export type ItemOutcome = CompletionReason | 'removed' | 'skipped';

/** What a channel does when an item ends: nothing, replay the item, or replay the whole queue. */
export type RepeatMode = 'off' | 'one' | 'all';

/** Image for lock screens and media notifications (same shape as the Media Session API's). */
export interface AudioArtwork {
  /** Size hint, for example `'512x512'`. */
  sizes?: string | undefined;
  /** Image URL. */
  src: string;
  /** MIME type, for example `'image/png'`. */
  type?: string | undefined;
}

/**
 * Information you attach to a queued item. It is returned in every event and snapshot for that
 * item, and `title`/`artist`/`album`/`artwork` are shown on lock screens by `connectMediaSession`.
 * Add any other fields you need (an id from your app, a transcript, ...).
 */
export interface AudioMetadata {
  /** Album or collection name. */
  album?: string | undefined;
  /** Artist, speaker or author. */
  artist?: string | undefined;
  /** Artwork for media controls. */
  artwork?: AudioArtwork[] | undefined;
  /** Display title. */
  title?: string | undefined;
  /** Any other data you want to carry with the item. */
  [key: string]: unknown;
}

/**
 * A point or range in an item's timeline. Cues fire `onAudioCue` events as playback reaches them:
 * use them for captions, karaoke lyrics, lip-sync, or triggering visuals at a moment in a track.
 */
export interface AudioCue {
  /** Any data you want back in the event (a caption id, an animation name, ...). */
  data?: unknown;
  /** End of the cue in milliseconds. Without it the cue is a point that fires once. */
  endMs?: number | undefined;
  /** Start of the cue in milliseconds from the beginning of the file. */
  startMs: number;
  /** Caption or lyric text. */
  text?: string | undefined;
}

/** Payload of the cue event. */
export interface AudioCueInfo {
  /** True when playback enters the cue, false when it leaves a ranged cue. */
  active: boolean;
  /** Channel the item plays on. */
  channelNumber: number;
  /** The cue, as you passed it. */
  cue: AudioCue;
  /** File name taken from the URL. */
  fileName: string;
  /** Unique id of the item. */
  id: number;
  /** Position of the cue in the item's (sorted) cue list. */
  index: number;
  /** Metadata given when the item was queued. */
  metadata: AudioMetadata | undefined;
  /** Resolved source URL. */
  src: string;
}

/** A finished item, as recorded in a channel's history. */
export interface HistoryEntry {
  /** Channel the item played on. */
  channelNumber: number;
  /** File name taken from the URL (or the File name for File sources). */
  fileName: string;
  /** `Date.now()` when the item finished. */
  finishedAt: number;
  /** Unique id of the item. */
  id: number;
  /** Metadata given when the item was queued. */
  metadata: AudioMetadata | undefined;
  /** Milliseconds of audio played before the item finished. */
  playedMs: number;
  /** Why the item finished. */
  reason: CompletionReason;
  /** Source URL. */
  src: string;
}

/** When to route audio through the Web Audio API (needed for volume control on iOS). */
export type WebAudioMode = 'off' | 'auto' | 'force';

/** Options for a single queued item. */
export interface AudioQueueOptions {
  /** Insert right after the currently playing item instead of at the end. */
  addToFront?: boolean | undefined;
  /**
   * Ignore this call if the same source was queued on this channel within the last `dedupeMs`
   * milliseconds (for notification sounds that may fire in bursts). The returned handle settles
   * with `'skipped'`.
   */
  dedupeMs?: number | undefined;
  /**
   * Stop the current item and clear the channel, then play this one immediately
   * (barge-in for voice assistants, or a sound that replaces whatever is playing).
   */
  interrupt?: boolean | undefined;
  /** Information returned with every event for this item; see {@link AudioMetadata}. */
  metadata?: AudioMetadata | undefined;
  /** Playback speed for this item (0.25-4, pitch preserved). Multiplied with the channel rate. */
  playbackRate?: number | undefined;
  /** Start playback this many milliseconds into the file (for resuming). */
  startAt?: number | undefined;
  /**
   * CORS mode for the element. Set this when the file is on another origin that sends CORS
   * headers and you need Web Audio volume control (iOS) for it.
   */
  crossOrigin?: 'anonymous' | 'use-credentials' | undefined;
  /** Repeat this item until it is stopped. */
  loop?: boolean | undefined;
  /** Cues that fire `onAudioCue` events during playback (captions, lyrics, lip-sync). */
  cues?: AudioCue[] | undefined;
  /**
   * Stop playback at this position (milliseconds) as if the file ended there. With `startAt` this
   * plays one segment of a longer file (audio sprites); with `loop` the segment repeats.
   */
  endAt?: number | undefined;
  /** Queue limit for this call only. Overrides the channel and default limits. */
  maxQueueSize?: number | undefined;
  /** Item volume (0-1). Multiplied with the channel and global volume. Defaults to 1. */
  volume?: number | undefined;
}

/** Minimal logger interface used for library warnings. */
export interface Logger {
  /** Logs an error (listener exceptions). */
  error: (...args: unknown[]) => void;
  /** Logs a warning (queue limits). */
  warn: (...args: unknown[]) => void;
}

/** Configuration for an audio queue instance. */
export interface QueueConfig {
  /** Default maximum items per channel, including the playing item. Unlimited when undefined. */
  defaultMaxQueueSize?: number | undefined;
  /** When a channel is full, drop the oldest waiting item instead of rejecting the new one. */
  dropOldestWhenFull: boolean;
  /** Milliseconds the front item may take to start before it is skipped with a timeout error. */
  loadTimeoutMs: number;
  /** Logger for warnings and listener errors. `null` silences the library. */
  logger: Logger | null;
  /** Highest channel number allowed is `maxChannels - 1`. */
  maxChannels: number;
  /** Finished items remembered per channel for `getHistory` (0 turns history off). */
  historySize: number;
  /**
   * Pause playing channels while the page is hidden (tab switched, phone locked) and resume them
   * when it is visible again.
   */
  pauseWhenHidden: boolean;
  /** How many items after the playing one are preloaded. The rest are not fetched until needed. */
  prefetchCount: number;
  /** Log a warning when a queue limit is hit. */
  showQueueWarnings: boolean;
  /** When to use the Web Audio API for volume. `auto` uses it on iOS for same-origin sources. */
  webAudio: WebAudioMode;
}

/** Volume ducking: lower other channels while the priority channel has audio. */
export interface VolumeConfig {
  /** Fade duration in ms when ducking starts. Defaults to 250. */
  duckTransitionDuration?: number | undefined;
  /** Volume multiplier (0-1) applied to every other channel while ducking. */
  duckingVolume: number;
  /** Channel whose audio triggers ducking. */
  priorityChannel: number;
  /** Volume multiplier (0-1) applied to the priority channel while it plays. */
  priorityVolume: number;
  /** Fade duration in ms when ducking ends. Defaults to 250. */
  restoreTransitionDuration?: number | undefined;
  /** Easing for ducking transitions. Defaults to ease-out. */
  transitionEasing?: EasingType | undefined;
}

/** Fade settings for a fade preset. */
export interface FadeConfig {
  /** Default fade duration in milliseconds. */
  duration: number;
  /** Curve used when fading out to pause. */
  pauseCurve: EasingType;
  /** Curve used when fading in on resume. */
  resumeCurve: EasingType;
}

/** Playback state of the item at the front of a channel. */
export interface AudioInfo {
  /** Playback position in milliseconds. */
  currentTime: number;
  /** Duration in milliseconds (0 while unknown or for live streams). */
  duration: number;
  /** File name taken from the URL, decoded. Not HTML-escaped: escape when rendering as HTML. */
  fileName: string;
  /** Unique id of the item. */
  id: number;
  /** Whether the item is still loading (not enough data to play yet). */
  isLoading: boolean;
  /** Whether the item loops. */
  isLooping: boolean;
  /** Whether playback is paused. */
  isPaused: boolean;
  /** Whether audio is actively playing. */
  isPlaying: boolean;
  /** Metadata given when the item was queued. */
  metadata: AudioMetadata | undefined;
  /** Effective playback speed (item rate × channel rate). */
  playbackRate: number;
  /** Progress from 0 to 1. */
  progress: number;
  /** Items waiting after this one. */
  remainingInQueue: number;
  /** Resolved source URL. */
  src: string;
  /** Effective output volume (0-1) after channel, item, global, ducking and fade. */
  volume: number;
}

/** Payload of the start event. */
export interface AudioStartInfo {
  /** Channel the item plays on. */
  channelNumber: number;
  /** Duration in milliseconds (0 while unknown). */
  duration: number;
  /** File name taken from the URL. */
  fileName: string;
  /** Unique id of the item. */
  id: number;
  /** Metadata given when the item was queued. */
  metadata: AudioMetadata | undefined;
  /** Resolved source URL. */
  src: string;
}

/** Payload of the complete event. */
export interface AudioCompleteInfo {
  /** Channel the item played on. */
  channelNumber: number;
  /** File name taken from the URL. */
  fileName: string;
  /** Unique id of the item. */
  id: number;
  /** Metadata given when the item was queued. */
  metadata: AudioMetadata | undefined;
  /** Milliseconds of audio played before the item finished. */
  playedMs: number;
  /** Why the item finished. */
  reason: CompletionReason;
  /** Items left in the channel after this one was removed. */
  remainingInQueue: number;
  /** Resolved source URL. */
  src: string;
}

/** Payload of the error event. */
export interface AudioErrorInfo {
  /** Channel of the failing item. */
  channelNumber: number;
  /** Underlying error. */
  error: Error;
  /** Category of the error. */
  errorType: AudioErrorType;
  /** File name taken from the URL. */
  fileName: string;
  /** Unique id of the failing item. */
  id: number;
  /** Metadata given when the item was queued. */
  metadata: AudioMetadata | undefined;
  /** Items left in the channel after the failing one was removed. */
  remainingInQueue: number;
  /** Resolved source URL. */
  src: string;
  /** `Date.now()` when the error happened. */
  timestamp: number;
}

/** One entry in a queue snapshot. */
export interface QueueItem {
  /** Duration in milliseconds (0 until the file's metadata has loaded). */
  duration: number;
  /** File name taken from the URL. */
  fileName: string;
  /** Unique id of the queued item. */
  id: number;
  /** Whether this is the front item and it is playing. */
  isCurrentlyPlaying: boolean;
  /** Whether the item loops. */
  isLooping: boolean;
  /** Metadata given when the item was queued. */
  metadata: AudioMetadata | undefined;
  /** Item playback speed (before the channel rate). */
  playbackRate: number;
  /** Resolved source URL. */
  src: string;
  /** Item volume multiplier (0-1). */
  volume: number;
}

/** State of one channel's queue. */
export interface QueueSnapshot {
  /** Channel number. */
  channelNumber: number;
  /** Index of the playing item: 0 when the queue has items, -1 when it is empty. */
  currentIndex: number;
  /** Whether the channel is paused. */
  isPaused: boolean;
  /** Items in play order; index 0 is the current item. */
  items: QueueItem[];
  /** Number of items. */
  totalItems: number;
  /** Channel volume (0-1) before global volume, ducking and fades. */
  volume: number;
}

/** Result of a queue manipulation call. */
export interface QueueManipulationResult {
  /** Explanation when `success` is false. */
  error?: string | undefined;
  /** Whether the change was applied. */
  success: boolean;
  /** Queue state after the change. */
  updatedQueue?: QueueSnapshot | undefined;
}

/** Handle for an item returned by `queueAudio`. */
export interface QueuedAudio {
  /** Channel the item was queued on. */
  channelNumber: number;
  /** Settles when the item leaves the queue, with the reason. Always settles. */
  finished: Promise<ItemOutcome>;
  /** Unique id of the item (matches `QueueItem.id`). */
  id: number;
  /** Metadata given when the item was queued. */
  metadata: AudioMetadata | undefined;
  /** Resolved source URL (an object URL for Blob sources). */
  src: string;
  /** Resolves `true` when playback starts, or `false` if the item leaves the queue first. */
  started: Promise<boolean>;
}

/** Information about Web Audio API use. */
export interface WebAudioSupport {
  /** Whether the Web Audio API exists in this environment. */
  available: boolean;
  /** Whether the device looks like iOS/iPadOS. */
  isIOS: boolean;
  /** Human-readable explanation of `usingWebAudio`. */
  reason: string;
  /** Whether new same-origin items will be routed through Web Audio. */
  usingWebAudio: boolean;
}

/** Listener for progress updates. */
export type ProgressCallback = (info: AudioInfo) => void;
/** Listener for queue changes. */
export type QueueChangeCallback = (snapshot: QueueSnapshot) => void;
/** Listener for playback starts. */
export type AudioStartCallback = (info: AudioStartInfo) => void;
/** Listener for completions (ended, stopped, or failed). */
export type AudioCompleteCallback = (info: AudioCompleteInfo) => void;
/** Listener for pauses. */
export type AudioPauseCallback = (channelNumber: number, info: AudioInfo) => void;
/** Listener for resumes. */
export type AudioResumeCallback = (channelNumber: number, info: AudioInfo) => void;
/** Listener for errors. */
export type AudioErrorCallback = (info: AudioErrorInfo) => void;
/** Listener for cue enter/exit events. */
export type AudioCueCallback = (info: AudioCueInfo) => void;
/** What can be queued: a URL (relative, absolute, blob: or data:) or a Blob/File. */
export type AudioSource = string | Blob;
/** Removes the listener it was returned for. Safe to call more than once. */
export type Unsubscribe = () => void;
