/**
 * @fileoverview Small pure helpers shared across modules.
 */

/**
 * Clamps a number to the 0-1 range. Non-finite input becomes `fallback`.
 * @param value - Number to clamp
 * @param fallback - Value used when `value` is NaN or infinite
 * @returns The clamped value
 */
export const clampUnit = (value: number, fallback: number = 1): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
};

/**
 * Throws a RangeError unless `channelNumber` is an integer in `[0, maxChannels)`.
 * @param channelNumber - Channel number to check
 * @param maxChannels - Number of allowed channels
 */
export const assertChannelNumber = (channelNumber: number, maxChannels: number): void => {
  if (!Number.isInteger(channelNumber) || channelNumber < 0 || channelNumber >= maxChannels) {
    throw new RangeError(
      `Invalid channel number ${String(channelNumber)}: expected an integer from 0 to ${
        maxChannels - 1
      }`
    );
  }
};

/**
 * Extracts a readable file name from a URL. The result is plain text, not HTML-escaped.
 * @param url - Absolute or relative URL
 * @returns The decoded last path segment, or `'unknown'`
 * @example
 * ```typescript
 * extractFileName('https://cdn.example.com/sfx/rock%20%26%20roll.mp3?v=2'); // 'rock & roll.mp3'
 * ```
 */
export const extractFileName = (url: string): string => {
  if (typeof url !== 'string' || url.length === 0) return 'unknown';
  if (url.startsWith('data:')) return 'data-uri';
  const withoutQuery = url.split(/[?#]/)[0] ?? '';
  const segments = withoutQuery.split('/');
  const last = segments[segments.length - 1] ?? '';
  if (last.length === 0) return 'unknown';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

/**
 * Returns a monotonic timestamp in milliseconds.
 * @returns `performance.now()` when available, otherwise `Date.now()`
 */
export const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/**
 * Converts a media time in seconds to milliseconds, mapping NaN and Infinity to 0.
 * @param seconds - Time in seconds
 * @returns Time in milliseconds
 */
export const secondsToMs = (seconds: number): number =>
  Number.isFinite(seconds) ? seconds * 1000 : 0;

/** Longest delay timers support (about 24.8 days); larger values fire immediately. */
export const MAX_TIMER_MS: number = 2 ** 31 - 1;

/**
 * Waits for a promise, but no longer than `ms` (0 or less waits without a limit).
 * @param promise - Promise to wait for
 * @param ms - Maximum wait in milliseconds
 * @returns Resolves when the promise settles or the time is up; never rejects
 */
export const settleWithin = (promise: Promise<unknown>, ms: number): Promise<void> => {
  const settled = promise.then(
    () => undefined,
    () => undefined
  );
  if (!(ms > 0)) return settled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.min(ms, MAX_TIMER_MS));
  });
  return Promise.race([settled, limit]).then(() => clearTimeout(timer));
};
