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
    expect(typeof audioq.getDefaultAudioQueue).toBe('function');
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
