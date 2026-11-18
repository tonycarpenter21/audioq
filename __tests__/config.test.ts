import {
  DEFAULT_DUCK_TRANSITION_MS,
  consoleLogger,
  defaultQueueConfig,
  getFadeConfig,
  mergeQueueConfig,
  validateVolumeConfig
} from '../src/config';
import { EasingType, FadeType, MAX_CHANNELS } from '../src/types';

describe('defaultQueueConfig', () => {
  test('returns safe defaults as a fresh object each time', () => {
    const a = defaultQueueConfig();
    expect(a).toMatchObject({
      dropOldestWhenFull: false,
      loadTimeoutMs: 15000,
      maxChannels: MAX_CHANNELS,
      prefetchCount: 1,
      showQueueWarnings: true,
      webAudio: 'auto'
    });
    expect(a.defaultMaxQueueSize).toBeUndefined();
    expect(defaultQueueConfig()).not.toBe(a);
  });
});

describe('consoleLogger', () => {
  test('forwards to console', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleLogger.warn('w', 1);
    consoleLogger.error('e', 2);
    expect(warn).toHaveBeenCalledWith('w', 1);
    expect(error).toHaveBeenCalledWith('e', 2);
  });
});

describe('getFadeConfig', () => {
  test('returns paired curves for each preset', () => {
    expect(getFadeConfig(FadeType.Gentle)).toEqual({
      duration: 800,
      pauseCurve: EasingType.EaseOut,
      resumeCurve: EasingType.EaseIn
    });
    expect(getFadeConfig(FadeType.Dramatic).pauseCurve).toBe(EasingType.EaseIn);
    expect(getFadeConfig(FadeType.Linear).resumeCurve).toBe(EasingType.Linear);
  });

  test('returns a copy and falls back to Gentle for unknown names', () => {
    const copy = getFadeConfig(FadeType.Linear);
    copy.duration = 1;
    expect(getFadeConfig(FadeType.Linear).duration).toBe(800);
    expect(getFadeConfig('nope' as FadeType)).toEqual(getFadeConfig(FadeType.Gentle));
  });
});

describe('mergeQueueConfig', () => {
  const base = defaultQueueConfig();

  test('merges valid changes', () => {
    expect(mergeQueueConfig(base, { defaultMaxQueueSize: 3, webAudio: 'off' })).toMatchObject({
      defaultMaxQueueSize: 3,
      webAudio: 'off'
    });
  });

  test.each([
    [{ defaultMaxQueueSize: 0 }, /defaultMaxQueueSize/],
    [{ maxChannels: 0 }, /maxChannels/],
    [{ maxChannels: 2.5 }, /maxChannels/],
    [{ prefetchCount: -1 }, /prefetchCount/],
    [{ loadTimeoutMs: -1 }, /loadTimeoutMs/],
    [{ webAudio: 'sometimes' as 'auto' }, /webAudio/]
  ])('rejects %p', (patch, message) => {
    expect(() => mergeQueueConfig(base, patch)).toThrow(message);
  });

  test('loadTimeoutMs 0 disables the timeout', () => {
    expect(mergeQueueConfig(base, { loadTimeoutMs: 0 }).loadTimeoutMs).toBe(0);
  });
});

describe('validateVolumeConfig', () => {
  test('clamps volumes and keeps the rest', () => {
    const result = validateVolumeConfig(
      { duckingVolume: -1, priorityChannel: 2, priorityVolume: 5, restoreTransitionDuration: 10 },
      64
    );
    expect(result).toEqual({
      duckingVolume: 0,
      priorityChannel: 2,
      priorityVolume: 1,
      restoreTransitionDuration: 10
    });
  });

  test('treats non-numeric volumes as 0', () => {
    const result = validateVolumeConfig(
      { duckingVolume: NaN, priorityChannel: 0, priorityVolume: 1 },
      64
    );
    expect(result.duckingVolume).toBe(0);
  });

  test.each([-1, 64, 1.5])('rejects priority channel %p', (priorityChannel) => {
    expect(() =>
      validateVolumeConfig({ duckingVolume: 0.2, priorityChannel, priorityVolume: 1 }, 64)
    ).toThrow(RangeError);
  });

  test('exposes the default duck transition', () => {
    expect(DEFAULT_DUCK_TRANSITION_MS).toBe(250);
  });
});
