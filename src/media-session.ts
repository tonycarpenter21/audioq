/**
 * @fileoverview Lock-screen and media-notification controls (Media Session API) for one channel.
 * A standalone function, so apps that do not use it do not ship it.
 */

import type { AudioQueue } from './audio-queue.js';
import { getDefaultAudioQueue } from './default-queue.js';
import type { AudioInfo, AudioMetadata, AudioStartInfo, Unsubscribe } from './types.js';

/** Options for {@link connectMediaSession}. */
export interface MediaSessionOptions {
  /** Channel whose audio is shown and controlled (defaults to 0). */
  channel?: number;
  /** Queue to connect (defaults to the queue behind the top-level functions). */
  queue?: AudioQueue;
  /** Skip distance for the seek-backward/forward buttons when the OS gives none (ms, default 10000). */
  seekOffsetMs?: number;
}

type Handler = (details: MediaSessionActionDetails) => void;

const setMetadata = (
  session: MediaSession,
  info: Pick<AudioStartInfo, 'fileName' | 'metadata'>
): void => {
  if (typeof MediaMetadata === 'undefined') return;
  const metadata: AudioMetadata = info.metadata ?? {};
  session.metadata = new MediaMetadata({
    album: metadata.album ?? '',
    artist: metadata.artist ?? '',
    artwork: metadata.artwork ?? [],
    title: metadata.title ?? info.fileName
  });
};

const setPosition = (session: MediaSession, info: AudioInfo): void => {
  if (!(info.duration > 0) || typeof session.setPositionState !== 'function') return;
  try {
    session.setPositionState({
      duration: info.duration / 1000,
      playbackRate: info.playbackRate,
      position: Math.min(info.currentTime, info.duration) / 1000
    });
  } catch {
    // Some browsers reject position updates while metadata is loading; the next one will work.
  }
};

/**
 * Shows a channel's current item on the lock screen, in media notifications and in the browser's
 * media controls, and makes their buttons (play, pause, stop, next, previous, seek) control it.
 * Title, artist, album and artwork come from the item's `metadata`; the file name is the fallback
 * title. Does nothing (and returns a no-op) where the Media Session API is unavailable.
 * @param options - Channel, queue and seek distance
 * @returns Function that disconnects the controls again
 * @example
 * ```typescript
 * const disconnect = connectMediaSession({ channel: 0 });
 * await queueAudio('/episodes/42.mp3', 0, { metadata: { artist: 'My Podcast', title: 'Episode 42' } });
 * ```
 */
export const connectMediaSession = (options: MediaSessionOptions = {}): Unsubscribe => {
  const session = typeof navigator === 'undefined' ? undefined : navigator.mediaSession;
  if (!session) return () => undefined;
  const queue = options.queue ?? getDefaultAudioQueue();
  const channel = options.channel ?? 0;
  const handlers = actionHandlers(queue, channel, options.seekOffsetMs ?? 10000);
  const setHandler = (action: MediaSessionAction, handler: Handler | null): void => {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // Browsers throw for actions they do not support; the others still work.
    }
  };
  handlers.forEach(([action, handler]) => setHandler(action, handler));
  const unsubscribers = followQueue(session, queue, channel);

  const current = queue.getCurrentAudioInfo(channel);
  if (current) {
    setMetadata(session, current);
    session.playbackState = current.isPaused ? 'paused' : 'playing';
  }

  return (): void => {
    unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    handlers.forEach(([action]) => setHandler(action, null));
    session.metadata = null;
    session.playbackState = 'none';
  };
};

/** Media-control buttons mapped to queue operations on one channel. */
const actionHandlers = (
  queue: AudioQueue,
  channel: number,
  offsetMs: number
): [MediaSessionAction, Handler][] => {
  const skipMs = (details: MediaSessionActionDetails): number =>
    details.seekOffset !== undefined ? details.seekOffset * 1000 : offsetMs;
  return [
    ['play', () => void queue.resumeChannel(channel)],
    ['pause', () => void queue.pauseChannel(channel)],
    ['stop', () => void queue.stopAllAudioInChannel(channel)],
    ['nexttrack', () => void queue.stopCurrentAudioInChannel(channel)],
    ['previoustrack', () => queue.seekTo(channel, 0)],
    ['seekbackward', (details) => queue.seekBy(channel, -skipMs(details))],
    ['seekforward', (details) => queue.seekBy(channel, skipMs(details))],
    [
      'seekto',
      (details) => {
        if (details.seekTime !== undefined) queue.seekTo(channel, details.seekTime * 1000);
      }
    ]
  ];
};

/** Keeps the session's metadata, state and position in step with a channel. */
const followQueue = (session: MediaSession, queue: AudioQueue, channel: number): Unsubscribe[] => [
  queue.onAudioStart(channel, (info) => {
    setMetadata(session, info);
    session.playbackState = 'playing';
  }),
  queue.onAudioResume(channel, (_channel, info) => {
    session.playbackState = 'playing';
    setPosition(session, info);
  }),
  queue.onAudioPause(channel, (_channel, info) => {
    session.playbackState = 'paused';
    setPosition(session, info);
  }),
  queue.onAudioProgress(channel, (info) => setPosition(session, info)),
  queue.onAudioComplete(channel, (info) => {
    if (info.remainingInQueue > 0) return;
    session.metadata = null;
    session.playbackState = 'none';
  })
];
