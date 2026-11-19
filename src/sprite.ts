/**
 * @fileoverview Audio sprites: many short sounds in one file, played by name. A standalone
 * helper, so apps that do not use it do not ship it.
 */

import type { AudioQueue } from './audio-queue.js';
import { getDefaultAudioQueue } from './default-queue.js';
import type { AudioQueueOptions, QueuedAudio } from './types.js';

/** One sound in a sprite: `[startMs, endMs]`, or an object that can also make it loop. */
export type SpriteSegment =
  readonly [number, number] | { endMs: number; loop?: boolean; startMs: number };

/** Sound names mapped to their position in the file. */
export type SpriteMap = Readonly<Record<string, SpriteSegment>>;

/** A sprite created by {@link defineSprite}. */
export interface AudioSprite<Name extends string> {
  /** The sound names in the sprite. */
  readonly names: readonly Name[];
  /**
   * Queues one sound from the sprite.
   * @param name - Sound name
   * @param channelNumber - Channel to queue on (defaults to 0)
   * @param options - Item options; `startAt`/`endAt` come from the sprite
   * @returns The queued item's handle
   */
  play: (name: Name, channelNumber?: number, options?: AudioQueueOptions) => Promise<QueuedAudio>;
}

/**
 * Defines an audio sprite: one file containing several sounds, played by name. One download
 * serves every sound, which suits games and UI feedback. To let rapid sounds cut each other off
 * use `{ interrupt: true }`; to let them overlap, play them on different channels.
 * @param source - URL of the sprite file
 * @param map - Sound names mapped to `[startMs, endMs]` (or `{ startMs, endMs, loop }`)
 * @param queue - Queue to play on (defaults to the queue behind the top-level functions)
 * @returns The sprite, with `play(name, channel?, options?)`
 * @example
 * ```typescript
 * const sfx = defineSprite('/sfx/sprite.mp3', { coin: [0, 300], jump: [400, 900] });
 * await sfx.play('coin', 2, { interrupt: true });
 * ```
 */
export const defineSprite = <Name extends string>(
  source: string,
  map: Readonly<Record<Name, SpriteSegment>>,
  queue?: AudioQueue
): AudioSprite<Name> => {
  const names = Object.keys(map) as Name[];
  for (const name of names) {
    const { endMs, startMs } = segmentOf(map[name]);
    if (!(Number.isFinite(startMs) && startMs >= 0 && Number.isFinite(endMs) && endMs > startMs)) {
      throw new RangeError(`Sprite "${name}" needs 0 <= startMs < endMs`);
    }
  }
  return {
    names,
    play: (name, channelNumber = 0, options = {}) => {
      const segment = map[name] as SpriteSegment | undefined;
      if (segment === undefined) {
        return Promise.reject(new RangeError(`Unknown sprite "${String(name)}"`));
      }
      const { endMs, loop, startMs } = segmentOf(segment);
      return (queue ?? getDefaultAudioQueue()).queueAudio(source, channelNumber, {
        ...options,
        endAt: endMs,
        loop: options.loop ?? loop,
        startAt: startMs
      });
    }
  };
};

const segmentOf = (segment: SpriteSegment): { endMs: number; loop: boolean; startMs: number } =>
  'startMs' in segment
    ? { endMs: segment.endMs, loop: segment.loop === true, startMs: segment.startMs }
    : { endMs: segment[1], loop: false, startMs: segment[0] };
