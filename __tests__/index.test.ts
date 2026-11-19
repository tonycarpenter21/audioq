import * as audioq from '../src/index';

describe('package entry point', () => {
  test('exports the instance API', () => {
    expect(typeof audioq.createAudioQueue).toBe('function');
    expect(typeof audioq.AudioQueue).toBe('function');
    expect(audioq.createAudioQueue({ logger: null })).toBeInstanceOf(audioq.AudioQueue);
  });

  test('exports the top-level functions bound to the default queue', () => {
    expect(typeof audioq.queueAudio).toBe('function');
    expect(typeof audioq.connectMediaSession).toBe('function');
    expect(typeof audioq.defineSprite).toBe('function');
    expect(audioq.parseWebVtt('')).toEqual([]);
    expect(audioq.parseVttTimestamp('00:01.000')).toBe(1000);
    expect(typeof audioq.getDefaultAudioQueue).toBe('function');
    expect(typeof audioq.createChannelStore).toBe('function');
    expect(typeof audioq.preloadAudio).toBe('function');
    expect(audioq.isAudioPreloaded('/never.mp3')).toBe(false);
    expect(typeof audioq.releasePreloadedAudio).toBe('function');
  });

  test('every export is defined', () => {
    // A re-export of a name that no longer exists compiles to an undefined value.
    const undefinedExports = Object.entries(audioq as Record<string, unknown>)
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    expect(undefinedExports).toEqual([]);
  });

  test('exports helpers, enums and constants', () => {
    expect(audioq.getFadeConfig(audioq.FadeType.Linear).duration).toBe(800);
    expect(audioq.extractFileName('/a%20b.mp3')).toBe('a b.mp3');
    expect(typeof audioq.isIOSDevice()).toBe('boolean');
    expect(typeof audioq.isWebAudioSupported()).toBe('boolean');
    expect(audioq.MAX_CHANNELS).toBe(64);
    expect(audioq.AudioErrorType.AutoplayBlocked).toBe('autoplay-blocked');
    expect(audioq.EasingType.EaseOut).toBe('ease-out');
  });

  test('importing has no side effects (no queue, element or context is created)', () => {
    jest.isolateModules(() => {
      const AudioSpy = jest.fn();
      (globalThis as { Audio?: unknown }).Audio = AudioSpy;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../src/index');
      expect(AudioSpy).not.toHaveBeenCalled();
    });
  });

  test('does not export the removed v2 internals', () => {
    const removed = [
      'audioChannels',
      'validateAudioUrl',
      'sanitizeForDisplay',
      'setRetryConfig',
      'retryFailedAudio',
      'createWebAudioNodes',
      'GLOBAL_PROGRESS_KEY'
    ];
    removed.forEach((name) => expect(audioq).not.toHaveProperty(name));
  });
});
