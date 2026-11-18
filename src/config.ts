/**
 * @fileoverview Default configuration, fade presets, and config validation.
 */

import { EasingType, FadeType, MAX_CHANNELS } from './types.js';
import type { FadeConfig, Logger, QueueConfig, VolumeConfig } from './types.js';

/** Logger that writes to the browser console. */
export const consoleLogger: Logger = {
  error: (...args: unknown[]): void => console.error(...args),
  warn: (...args: unknown[]): void => console.warn(...args)
};

/** Default fade duration for ducking transitions in milliseconds. */
export const DEFAULT_DUCK_TRANSITION_MS: number = 250;

/**
 * Returns the default queue configuration.
 * @returns A fresh copy of the defaults
 */
export const defaultQueueConfig = (): QueueConfig => ({
  defaultMaxQueueSize: undefined,
  dropOldestWhenFull: false,
  loadTimeoutMs: 15000,
  logger: consoleLogger,
  maxChannels: MAX_CHANNELS,
  prefetchCount: 1,
  showQueueWarnings: true,
  webAudio: 'auto'
});

const FADE_CONFIGS: Readonly<Record<FadeType, FadeConfig>> = {
  [FadeType.Dramatic]: {
    duration: 800,
    pauseCurve: EasingType.EaseIn,
    resumeCurve: EasingType.EaseOut
  },
  [FadeType.Gentle]: {
    duration: 800,
    pauseCurve: EasingType.EaseOut,
    resumeCurve: EasingType.EaseIn
  },
  [FadeType.Linear]: {
    duration: 800,
    pauseCurve: EasingType.Linear,
    resumeCurve: EasingType.Linear
  }
};

/**
 * Returns the settings for a fade preset.
 * @param fadeType - Preset name
 * @returns A copy of the preset (Gentle when the name is unknown)
 * @example
 * ```typescript
 * getFadeConfig(FadeType.Dramatic).duration; // 800
 * ```
 */
export const getFadeConfig = (fadeType: FadeType): FadeConfig => ({
  ...(FADE_CONFIGS[fadeType] ?? FADE_CONFIGS[FadeType.Gentle])
});

const isNonNegativeInteger = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Merges and validates a partial configuration.
 * @param base - Current configuration
 * @param patch - Changes to apply
 * @returns The merged configuration
 */
export const mergeQueueConfig = (base: QueueConfig, patch: Partial<QueueConfig>): QueueConfig => {
  const next: QueueConfig = { ...base, ...patch };
  if (next.defaultMaxQueueSize !== undefined && !(next.defaultMaxQueueSize >= 1)) {
    throw new RangeError('defaultMaxQueueSize must be at least 1');
  }
  if (!isNonNegativeInteger(next.maxChannels) || next.maxChannels < 1) {
    throw new RangeError('maxChannels must be a positive integer');
  }
  if (!isNonNegativeInteger(next.prefetchCount)) {
    throw new RangeError('prefetchCount must be a non-negative integer');
  }
  if (!(next.loadTimeoutMs >= 0)) {
    throw new RangeError('loadTimeoutMs must be 0 (disabled) or a positive number');
  }
  if (!['auto', 'force', 'off'].includes(next.webAudio)) {
    throw new RangeError('webAudio must be "off", "auto" or "force"');
  }
  return next;
};

/**
 * Validates a ducking configuration.
 * @param config - Ducking settings
 * @param maxChannels - Number of allowed channels
 * @returns A copy with volumes clamped to 0-1
 */
export const validateVolumeConfig = (config: VolumeConfig, maxChannels: number): VolumeConfig => {
  const { priorityChannel } = config;
  if (!Number.isInteger(priorityChannel) || priorityChannel < 0 || priorityChannel >= maxChannels) {
    throw new RangeError(
      `Invalid priority channel ${String(priorityChannel)}: expected 0 to ${maxChannels - 1}`
    );
  }
  const clamp = (value: number): number => Math.min(1, Math.max(0, Number(value) || 0));
  return {
    ...config,
    duckingVolume: clamp(config.duckingVolume),
    priorityVolume: clamp(config.priorityVolume)
  };
};
