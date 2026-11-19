/**
 * @fileoverview Cancellable, time-based numeric transitions.
 * Uses timers rather than requestAnimationFrame so fades finish in background tabs.
 */

import { EasingType } from './types.js';
import { now } from './utils.js';

/** Easing functions mapping progress (0-1) to eased progress (0-1). */
export const EASINGS: Readonly<Record<EasingType, (t: number) => number>> = {
  [EasingType.EaseIn]: (t: number): number => t * t,
  [EasingType.EaseInOut]: (t: number): number => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  [EasingType.EaseOut]: (t: number): number => t * (2 - t),
  [EasingType.Linear]: (t: number): number => t
};

/** Interval between transition steps in milliseconds. */
export const TWEEN_STEP_MS: number = 16;

/** A running transition. */
export interface Tween {
  /** Stops the transition where it is. `done` resolves with `false`. */
  cancel: () => void;
  /** Resolves `true` when the transition reaches its target, `false` if cancelled. Always settles. */
  readonly done: Promise<boolean>;
}

/** Options for {@link startTween}. */
export interface TweenOptions {
  /** Duration in milliseconds. 0 or less jumps straight to `to`. */
  duration: number;
  /** Easing curve. */
  easing: EasingType;
  /** Start value. */
  from: number;
  /** Called with each intermediate value and finally with `to`. */
  onUpdate: (value: number) => void;
  /** Target value. */
  to: number;
}

/**
 * Starts a transition from `from` to `to`.
 * @param options - Transition settings
 * @returns A handle that can cancel the transition and await its end
 */
export const startTween = (options: TweenOptions): Tween => {
  const { duration, from, onUpdate, to } = options;
  // Plain-JavaScript callers can pass any string, so the lookup may miss.
  const easings: Readonly<Record<string, ((t: number) => number) | undefined>> = EASINGS;
  const ease = easings[options.easing] ?? EASINGS[EasingType.Linear];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let settle: (completed: boolean) => void = () => undefined;
  const done: Promise<boolean> = new Promise((resolve) => {
    settle = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(completed);
    };
  });

  // Zero, negative, NaN and infinite durations apply immediately, so a transition always ends.
  if (!(duration > 0) || !Number.isFinite(duration) || from === to) {
    onUpdate(to);
    settle(true);
    return { cancel: (): void => undefined, done };
  }

  const startedAt = now();
  const step = (): void => {
    if (settled) return;
    const progress = Math.min(1, (now() - startedAt) / duration);
    onUpdate(from + (to - from) * ease(progress));
    if (progress >= 1) {
      settle(true);
    } else {
      timer = setTimeout(step, TWEEN_STEP_MS);
    }
  };
  step();

  return { cancel: (): void => settle(false), done };
};
