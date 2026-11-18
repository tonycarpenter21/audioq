import { AudioErrorType, EasingType, FadeType, MAX_CHANNELS } from '../src/types';

describe('public enums and constants', () => {
  test('MAX_CHANNELS is 64', () => {
    expect(MAX_CHANNELS).toBe(64);
  });

  test('AudioErrorType values are stable strings', () => {
    expect(Object.values(AudioErrorType).sort()).toEqual([
      'abort',
      'autoplay-blocked',
      'decode',
      'network',
      'timeout',
      'unknown',
      'unsupported'
    ]);
  });

  test('EasingType values are stable strings', () => {
    expect(Object.values(EasingType).sort()).toEqual([
      'ease-in',
      'ease-in-out',
      'ease-out',
      'linear'
    ]);
  });

  test('FadeType values are stable strings', () => {
    expect(Object.values(FadeType).sort()).toEqual(['dramatic', 'gentle', 'linear']);
  });
});
