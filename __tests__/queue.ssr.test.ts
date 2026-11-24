/**
 * @jest-environment node
 */
import {
  createAudioQueue,
  destroyAllChannels,
  getQueueLength,
  getWebAudioSupport,
  queueAudio,
  unlockAudio
} from '../src/queue';
import {
  FakeAudio,
  FakeAudioContext,
  flush,
  installFakeAudio,
  installFakeAudioContext,
  removeAudioContext
} from './helpers/fake-audio';

afterEach(() => {
  removeAudioContext();
  delete (globalThis as { Audio?: unknown }).Audio;
});

describe('AudioQueue without a DOM (SSR, workers, tests)', () => {
  test('can be created and configured without touching browser globals', () => {
    const queue = createAudioQueue({ logger: null });
    expect(getQueueLength(queue)).toBe(0);
    expect(getWebAudioSupport(queue).available).toBe(false);
  });

  test('queueAudio explains that a browser is needed', async () => {
    await expect(queueAudio(createAudioQueue({ logger: null }), '/a.mp3')).rejects.toThrow(
      /browser environment/
    );
  });

  test('blocked autoplay without a document keeps the item and does not throw', async () => {
    installFakeAudio();
    FakeAudio.defaultPlayBehavior = 'not-allowed';
    const queue = createAudioQueue({ logger: null });
    await queueAudio(queue, '/a.mp3');
    await flush();
    expect(getQueueLength(queue)).toBe(1);
    unlockAudio(queue);
    await destroyAllChannels(queue);
  });

  test('without a page location only blob: and data: sources are routed through Web Audio', async () => {
    installFakeAudio();
    installFakeAudioContext();
    const queue = createAudioQueue({ logger: null, webAudio: 'force' });
    await queueAudio(queue, 'https://cdn.other.com/x.mp3', 0);
    await queueAudio(queue, 'blob:https://app.example.com/1', 1);
    expect((FakeAudioContext.instances[0] as FakeAudioContext).sources).toHaveLength(1);
    await destroyAllChannels(queue);
  });
});
