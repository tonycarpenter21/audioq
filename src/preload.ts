/**
 * @fileoverview Preloading: downloads files into memory so queued items start instantly, work
 * offline and can seek without the server's Range support.
 */

import type { AudioQueue } from './audio-queue.js';
import { getDefaultAudioQueue } from './default-queue.js';
import { resolveUrl, toError } from './media.js';
import { forgetMemory, memoryOf, peekMemory } from './memory.js';
import type { PreloadResult } from './types.js';

const list = (sources: string | readonly string[]): readonly string[] =>
  typeof sources === 'string' ? [sources] : sources;

const urlOf = (source: string): string => resolveUrl(source.trim());

/** Fetches a file as a Blob, giving up after `timeoutMs` (0 never gives up). */
const download = (url: string, timeoutMs: number): Promise<Blob> => {
  if (typeof fetch === 'undefined') {
    return Promise.reject(new Error('preloadAudio needs fetch (run it in a browser)'));
  }
  const controller = typeof AbortController === 'undefined' ? undefined : new AbortController();
  const timer =
    controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  return fetch(url, controller ? { signal: controller.signal } : {})
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${String(response.status)} loading ${url}`);
      return response.blob();
    })
    .finally(() => clearTimeout(timer));
};

/** Downloads one file into a queue's memory; never rejects. Concurrent calls share a download. */
const preloadOne = (queue: AudioQueue, url: string): Promise<PreloadResult> => {
  const memory = memoryOf(queue);
  const cached = memory.files.get(url);
  if (cached) return Promise.resolve({ bytes: cached.size, ok: true, src: url });
  const running = memory.downloads.get(url);
  if (running) return running;
  // Released (or the queue destroyed) while downloading: the download is no longer the current one.
  const isCurrent = (): boolean => peekMemory(queue)?.downloads.get(url) === attempt;
  const attempt: Promise<PreloadResult> = download(url, queue.getQueueConfig().loadTimeoutMs).then(
    (blob) => {
      if (isCurrent()) {
        memory.downloads.delete(url);
        memory.files.set(url, blob);
      }
      return { bytes: blob.size, ok: true, src: url };
    },
    (error: unknown) => {
      if (isCurrent()) memory.downloads.delete(url);
      return { bytes: 0, error: toError(error, 'Preload failed'), ok: false, src: url };
    }
  );
  memory.downloads.set(url, attempt);
  return attempt;
};

/**
 * Downloads files into memory so they start instantly and keep working offline. Items queued
 * with a preloaded URL play from memory (also making `startAt` and sprites independent of the
 * server's Range support). Files from another origin need CORS headers; downloads time out after
 * `loadTimeoutMs`. Never rejects: check each result's `ok`. A file that failed still plays from
 * the network.
 * @param sources - URL or URLs
 * @param queue - Queue the files are for (defaults to the default queue)
 * @returns One result per URL, in order
 * @example
 * ```ts
 * const results = await preloadAudio(['/sfx/coin.mp3', '/sfx/jump.mp3']);
 * results.filter((result) => !result.ok).forEach((result) => console.warn(result.error));
 * ```
 */
export const preloadAudio = (
  sources: string | readonly string[],
  queue: AudioQueue = getDefaultAudioQueue()
): Promise<PreloadResult[]> =>
  Promise.all(list(sources).map((source) => preloadOne(queue, urlOf(source))));

/**
 * Whether a URL is preloaded (and not released).
 * @param source - URL
 * @param queue - Queue (defaults to the default queue)
 * @returns True when the file is in memory
 */
export const isAudioPreloaded = (
  source: string,
  queue: AudioQueue = getDefaultAudioQueue()
): boolean => peekMemory(queue)?.files.has(urlOf(source)) === true;

/**
 * Frees preloaded files (every one without `sources`) and stops keeping downloads that are still
 * running. Sounds already queued keep playing. `destroyAllChannels()` also frees everything.
 * @param sources - URL or URLs to release
 * @param queue - Queue (defaults to the default queue)
 */
export const releasePreloadedAudio = (
  sources?: string | readonly string[],
  queue: AudioQueue = getDefaultAudioQueue()
): void => {
  if (sources === undefined) {
    forgetMemory(queue);
    return;
  }
  const memory = peekMemory(queue);
  for (const source of list(sources)) {
    memory?.files.delete(urlOf(source));
    memory?.downloads.delete(urlOf(source));
  }
};
