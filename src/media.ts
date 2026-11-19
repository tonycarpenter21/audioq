/**
 * @fileoverview HTMLAudioElement helpers: listening, releasing, and classifying errors.
 */

import { AudioErrorType } from './types.js';

/** Removes listeners added with {@link listen}. */
export type Disposer = () => void;

/**
 * Adds an event listener and returns a function that removes it.
 * @param target - Element or other event target
 * @param type - Event type
 * @param handler - Listener
 * @returns Function removing the listener
 */
export const listen = (target: EventTarget, type: string, handler: () => void): Disposer => {
  target.addEventListener(type, handler);
  return (): void => target.removeEventListener(type, handler);
};

/**
 * Resolves a URL against the page, the same way `HTMLAudioElement.src` would.
 * @param url - Absolute or relative URL
 * @returns The absolute URL, or the input unchanged when there is no document to resolve against
 */
export const resolveUrl = (url: string): string => {
  if (typeof document === 'undefined') return url;
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return url;
  }
};

/**
 * Stops an element and frees its network and decoder resources.
 * Removing `src` and calling `load()` is the documented way to abort a media fetch.
 * @param element - Element to release
 */
export const releaseElement = (element: HTMLAudioElement): void => {
  try {
    element.pause();
  } catch {
    // Already unusable; nothing to release.
  }
  element.removeAttribute('src');
  try {
    element.load();
  } catch {
    // Some environments (jsdom) do not implement load().
  }
};

/**
 * Whether a URL is same-origin (or origin-less, like blob: and data:), meaning Web Audio can read
 * its samples without CORS. Scheme and host are compared directly, because the URL standard gives
 * custom schemes such as `capacitor://localhost` an opaque ("null") origin.
 * @param src - Resolved URL of the element
 * @param pageUrl - URL of the current page
 * @returns True when routing through Web Audio will not produce silence
 */
export const isSameOriginSource = (src: string, pageUrl: string | undefined): boolean => {
  if (src.startsWith('blob:') || src.startsWith('data:')) return true;
  if (pageUrl === undefined) return false;
  try {
    const page = new URL(pageUrl);
    const source = new URL(src, page);
    return source.protocol === page.protocol && source.host === page.host;
  } catch {
    return false;
  }
};

/** Media error codes from the HTML spec (`MediaError.code`). */
const MEDIA_ERROR_TYPES: Readonly<Record<number, AudioErrorType>> = {
  1: AudioErrorType.Abort,
  2: AudioErrorType.Network,
  3: AudioErrorType.Decode,
  4: AudioErrorType.Unsupported
};

/**
 * Classifies an element's `error` property.
 * @param mediaError - `element.error`
 * @returns The matching error type
 */
export const categorizeMediaError = (
  mediaError: Pick<MediaError, 'code'> | null | undefined
): AudioErrorType => {
  if (!mediaError) return AudioErrorType.Unknown;
  return MEDIA_ERROR_TYPES[mediaError.code] ?? AudioErrorType.Unknown;
};

/**
 * Classifies a rejection from `element.play()` by its DOMException name.
 * @param error - Rejection value
 * @returns The error type, or `null` for AbortError (play() interrupted by pause() or a new source,
 * which is expected and not a failure)
 */
export const categorizePlayError = (error: unknown): AudioErrorType | null => {
  const name = error instanceof Error || isNamed(error) ? error.name : '';
  switch (name) {
    case 'AbortError':
      return null;
    case 'NotAllowedError':
      return AudioErrorType.AutoplayBlocked;
    case 'NotSupportedError':
      return AudioErrorType.Unsupported;
    default:
      return AudioErrorType.Unknown;
  }
};

const isNamed = (value: unknown): value is { name: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { name?: unknown }).name === 'string';

/**
 * Converts any thrown value to an Error.
 * @param value - Thrown value
 * @param fallbackMessage - Message used when `value` carries none
 * @returns An Error instance
 */
export const toError = (value: unknown, fallbackMessage: string): Error => {
  if (value instanceof Error) return value;
  if (isNamed(value)) {
    const error = new Error(
      (value as { message?: unknown }).message?.toString() ?? fallbackMessage
    );
    error.name = value.name;
    return error;
  }
  return new Error(fallbackMessage);
};
