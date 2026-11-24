/**
 * @fileoverview Regression tests from the adversarial review of the first v3 draft (BUG-1..19).
 * Each test failed on that draft and asserts the documented behaviour.
 */
import {
  AudioQueue,
  clearVolumeDucking,
  createAudioQueue,
  destroyAllChannels,
  destroyChannel,
  getAllChannelsPauseState,
  getCurrentAudioInfo,
  getGlobalVolume,
  getQueueLength,
  getQueueSnapshot,
  isChannelPaused,
  onAudioComplete,
  onAudioError,
  onAudioStart,
  pauseChannel,
  pauseWithFade,
  queueAudio,
  queueAudioPriority,
  resumeAllChannels,
  resumeChannel,
  setChannelVolume,
  setGlobalVolume,
  setQueueConfig,
  setVolumeDucking,
  stopAllAudio,
  stopCurrentAudioInChannel,
  togglePauseAllWithFade,
  togglePauseWithFade,
  unlockAudio
} from '../../src/queue';
import { isSameOriginSource } from '../../src/media';
import type { AudioErrorInfo, QueueConfig } from '../../src/types';
import { FadeType } from '../../src/types';
import {
  DESKTOP_UA,
  FakeAudio,
  FakeAudioContext,
  advance,
  audioAt,
  flush,
  installFakeAudio,
  installFakeAudioContext,
  removeAudioContext,
  setUserAgent
} from '../helpers/fake-audio';

const setup = (config: Partial<QueueConfig> = {}): AudioQueue =>
  createAudioQueue({ logger: null, ...config });

beforeEach(() => {
  jest.useFakeTimers();
  installFakeAudio();
  removeAudioContext();
  setUserAgent(DESKTOP_UA);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('BUG-1 un-awaited stopAllAudio kills audio queued right after it', () => {
  test('item queued on channel 1 right after `void stopAllAudio()` survives', async () => {
    const q = setup();
    await queueAudio(q, '/sfx.mp3', 0);
    await queueAudio(q, '/old-music.mp3', 1);
    void stopAllAudio(q); // e.g. scene change handler, not awaited
    const music = queueAudio(q, '/new-music.mp3', 1);
    const handle = await music;
    await flush();
    expect(getQueueLength(q, 1)).toBe(1); // actual: 0
    await expect(Promise.race([handle.finished, flush().then(() => 'pending')])).resolves.toBe(
      'pending'
    ); // actual: 'stopped'
  });
});

describe('BUG-2 un-awaited destroyChannel orphans the next item (React StrictMode cleanup)', () => {
  test('item queued right after `void destroyChannel(0)` is still controllable', async () => {
    const q = setup();
    await queueAudio(q, '/a.mp3', 0);
    void destroyChannel(q, 0); // useEffect cleanup cannot await
    const b = await queueAudio(q, '/b.mp3', 0); // effect re-runs (StrictMode remount)
    await flush();
    const bAudio = FakeAudio.instances.find((a) => a.src.endsWith('/b.mp3'));
    expect(bAudio?.paused).toBe(false); // it is audibly playing...
    expect(getQueueLength(q, 0)).toBe(1); // ...but the queue forgot it (actual: 0)
    await stopAllAudio(q);
    expect(bAudio?.paused).toBe(true); // actual: still playing, cannot be stopped
    await expect(Promise.race([b.finished, flush().then(() => 'pending')])).resolves.toBe(
      'stopped'
    );
  });

  test('listener registered right after `void destroyChannel(0)` is not silently dropped', async () => {
    const q = setup();
    await queueAudio(q, '/a.mp3', 0);
    void destroyChannel(q, 0);
    const onStart = jest.fn();
    onAudioStart(q, 0, onStart);
    await queueAudio(q, '/b.mp3', 0);
    await flush();
    expect(onStart).toHaveBeenCalledTimes(1); // actual: 0 (cleared by the deferred clearChannel)
  });

  test('`void destroyAllChannels()` then queueAudio (force Web Audio) routes into a closed context', async () => {
    installFakeAudioContext();
    const q = setup({ webAudio: 'force' });
    await queueAudio(q, '/a.mp3', 0);
    void destroyAllChannels(q);
    await queueAudio(q, '/b.mp3', 0);
    await flush(20);
    // b was connected to context #0, which destroyAllChannels then closed => silence on iOS.
    const ctx0 = FakeAudioContext.instances[0];
    expect(ctx0?.sources.length).toBe(1); // actual: 2 (b routed into ctx0)
    expect(getQueueLength(q, 0)).toBe(1); // actual: 0 (orphaned as well)
  });
});

describe('BUG-3 an error listener that skips the failing item also kills the next item', () => {
  test('stopCurrentAudioInChannel inside onAudioError does not remove the healthy next item', async () => {
    const q = setup();
    await queueAudio(q, '/broken.mp3');
    const good = await queueAudio(q, '/good.mp3');
    onAudioError(q, 0, () => void stopCurrentAudioInChannel(q, 0));
    const reasons: string[] = [];
    onAudioComplete(q, 0, (info) => reasons.push(`${info.fileName}:${info.reason}`));
    audioAt(0).fail(2, 'network');
    await flush();
    expect(getQueueLength(q, 0)).toBe(1); // actual: 0
    expect(reasons).toEqual(['broken.mp3:stopped']); // actual also has 'good.mp3:error'
    await expect(Promise.race([good.finished, flush().then(() => 'pending')])).resolves.toBe(
      'pending'
    );
  });
});

describe('BUG-4 pause-with-fade is lost when the track ends during the fade', () => {
  test('channel ends up paused (next item does not blast at full volume)', async () => {
    const q = setup();
    await queueAudio(q, '/a.mp3');
    await queueAudio(q, '/b.mp3');
    await flush();
    void pauseWithFade(q, FadeType.Linear, 0, 800);
    await advance(400);
    audioAt(0).finish(); // track happens to end mid-fade
    await advance(1000);
    expect(isChannelPaused(q, 0)).toBe(true); // actual: false, b.mp3 playing at full volume
  });
});

describe('BUG-5 documented "resume during fade-out cancels the pause" only works for resumeWithFade', () => {
  test('resumeChannel during pauseWithFade cancels the pause (JSDoc of pauseWithFade)', async () => {
    const q = setup();
    await queueAudio(q, '/a.mp3');
    await flush();
    void pauseWithFade(q, FadeType.Linear, 0, 800);
    await advance(200);
    await resumeChannel(q, 0);
    await advance(1000);
    expect(isChannelPaused(q, 0)).toBe(false); // actual: true
  });

  test('togglePauseWithFade clicked twice quickly resumes (rapid toggle)', async () => {
    const q = setup();
    await queueAudio(q, '/a.mp3');
    await flush();
    void togglePauseWithFade(q, FadeType.Linear, 0, 800);
    await advance(200);
    void togglePauseWithFade(q, FadeType.Linear, 0, 800); // user changes their mind
    await advance(2000);
    expect(isChannelPaused(q, 0)).toBe(false); // actual: true (second toggle fades out again)
  });

  test('togglePauseAllWithFade clicked twice quickly resumes', async () => {
    const q = setup();
    await queueAudio(q, '/a.mp3', 0);
    await flush();
    void togglePauseAllWithFade(q, FadeType.Linear, 800);
    await advance(200);
    void togglePauseAllWithFade(q, FadeType.Linear, 800);
    await advance(2000);
    expect(isChannelPaused(q, 0)).toBe(false); // actual: true
  });
});

describe('BUG-6 one AutoplayBlocked error is promised, but every failed gesture emits another', () => {
  test('a gesture that does not grant activation does not re-report the error', async () => {
    FakeAudio.defaultPlayBehavior = 'not-allowed';
    const q = setup();
    const errors: AudioErrorInfo[] = [];
    onAudioError(q, 0, (e) => errors.push(e));
    await queueAudio(q, '/a.mp3');
    await flush();
    expect(errors).toHaveLength(1);
    // e.g. touch pointerdown / Escape keydown are not activation-triggering: play() still rejects
    document.dispatchEvent(new Event('pointerdown'));
    await flush();
    document.dispatchEvent(new Event('keydown'));
    await flush();
    expect(errors).toHaveLength(1); // actual: 3
  });
});

describe('BUG-7 loadTimeoutMs: Infinity was accepted and then timed out immediately', () => {
  test('Infinity is rejected up front instead of firing after ~1ms', () => {
    expect(() => setup({ loadTimeoutMs: Infinity })).toThrow(RangeError);
    expect(() => setQueueConfig(setup(), { loadTimeoutMs: Infinity })).toThrow(RangeError);
  });

  test('values above 2^31-1 ms (~24.8 days) behave the same', () => {
    expect(() => setup({ loadTimeoutMs: 2 ** 31 })).toThrow(RangeError); // actual: accepted
  });
});

describe('BUG-8 externally paused element (OS media keys, iOS interruption, headset unplug) wedges the channel', () => {
  test('resumeChannel restarts an element the browser paused on its own', async () => {
    const q = setup();
    await queueAudio(q, '/a.mp3');
    await flush();
    audioAt(0).pause(); // browser/OS pauses the element
    expect(getCurrentAudioInfo(q, 0)?.isPaused).toBe(true);
    expect(isChannelPaused(q, 0)).toBe(true); // state follows the element (was inconsistent)
    await resumeChannel(q, 0);
    expect(audioAt(0).playCalls).toBe(2); // actual: 1, resumeChannel is a no-op
  });
});

describe('BUG-9 a paused channel starts playing by itself when its current item errors', () => {
  test('error on the paused head keeps the channel paused', async () => {
    const q = setup();
    await queueAudio(q, '/a.mp3');
    await queueAudio(q, '/b.mp3');
    await flush();
    await pauseChannel(q, 0);
    audioAt(0).fail(2, 'network dropped while paused');
    await flush();
    expect(audioAt(1).playCalls).toBe(0); // actual: 1 — b starts although the user paused
    expect(isChannelPaused(q, 0)).toBe(true);
  });
});

describe('BUG-10 Capacitor / Ionic iOS apps never get Web Audio volume control', () => {
  test('capacitor://localhost sources are same-origin with a capacitor://localhost page', () => {
    expect(isSameOriginSource('capacitor://localhost/sfx/a.mp3', 'capacitor://localhost')).toBe(
      true
    ); // actual: false (WHATWG URL origin of non-special schemes is "null")
  });
});

describe('BUG-11 iOS "interrupted" AudioContext is never resumed', () => {
  test('unlockAudio resumes an interrupted context', async () => {
    installFakeAudioContext();
    const q = setup({ webAudio: 'force' });
    await queueAudio(q, '/a.mp3');
    const ctx = FakeAudioContext.instances[0];
    if (!ctx) throw new Error('no context');
    ctx.resume.mockClear();
    (ctx as unknown as { state: string }).state = 'interrupted'; // Safari after a phone call
    unlockAudio(q);
    expect(ctx.resume).toHaveBeenCalled(); // actual: not called -> routed audio silent
  });
});

describe('BUG-12 non-finite durations never settle and keep a 16ms timer alive forever', () => {
  test('setChannelVolume(..., Infinity) settles', async () => {
    const q = setup();
    const done = setChannelVolume(q, 0, 0.2, Infinity);
    await advance(5000);
    await expect(
      Promise.race([done.then(() => 'settled'), flush().then(() => 'pending')])
    ).resolves.toBe('settled'); // actual: pending, timer count > 0 forever
  });

  test('pauseWithFade(..., Infinity) eventually pauses', async () => {
    const q = setup();
    await queueAudio(q, '/a.mp3');
    await flush();
    void pauseWithFade(q, FadeType.Gentle, 0, Infinity);
    await advance(5000);
    expect(isChannelPaused(q, 0)).toBe(true); // actual: false forever
  });
});

describe('BUG-13 items pushed out of the prefetch window keep downloading', () => {
  test('queueAudioPriority pushes the prefetched item to index 2; its element is released', async () => {
    const q = setup({ prefetchCount: 1 });
    await queueAudio(q, '/a.mp3');
    await queueAudio(q, '/b.mp3'); // prefetched
    for (const n of ['p1', 'p2', 'p3']) await queueAudioPriority(q, `/${n}.mp3`);
    const live = FakeAudio.instances.filter((a) => a.src !== '');
    // only a (current) + next item should hold a loading element
    expect(live).toHaveLength(2); // actual: 5
  });
});

describe('BUG-14 loadTimeoutMs change mid-flight reports the wrong duration', () => {
  test('error message states the timeout that actually applied', async () => {
    FakeAudio.defaultPlayBehavior = 'resolve-silently';
    const q = setup({ loadTimeoutMs: 1000 });
    const messages: string[] = [];
    onAudioError(q, 0, (e) => messages.push(e.error.message));
    await queueAudio(q, '/a.mp3');
    setQueueConfig(q, { loadTimeoutMs: 60000 });
    await advance(1100);
    expect(messages).toEqual(['Audio did not start within 1000ms']); // actual: '...60000ms'
  });
});

describe('BUG-15 clearVolumeDucking ignores restoreTransitionDuration', () => {
  test('restore uses the configured 1000ms, not the 250ms default', async () => {
    const q = setup();
    setVolumeDucking(q, {
      duckingVolume: 0.2,
      priorityChannel: 1,
      priorityVolume: 1,
      duckTransitionDuration: 0,
      restoreTransitionDuration: 1000
    });
    await queueAudio(q, '/music.mp3', 0);
    await queueAudio(q, '/voice.mp3', 1);
    await flush();
    expect(audioAt(0).volume).toBeCloseTo(0.2);
    clearVolumeDucking(q);
    await advance(300);
    expect(audioAt(0).volume).toBeLessThan(0.9); // actual: 1 after 250ms
  });
});

describe('BUG-16 per-call maxQueueSize is not validated (setChannelQueueLimit is)', () => {
  test.each([0, -1, NaN])(
    'maxQueueSize %p is rejected as a RangeError like elsewhere',
    async (n) => {
      const q = setup({ dropOldestWhenFull: true });
      await expect(queueAudio(q, '/a.mp3', 0, { maxQueueSize: n })).rejects.toThrow(RangeError);
      // actual: generic Error('Queue size limit exceeded for channel 0') on an EMPTY channel
    }
  );
});

describe('BUG-17 rejected queueAudio leaves a phantom channel behind', () => {
  test('a failed queueAudio does not create channel state', async () => {
    const q = setup({ defaultMaxQueueSize: 1 });
    await expect(queueAudio(q, '/a.mp3', 7, { maxQueueSize: 0 })).rejects.toThrow();
    expect(getQueueSnapshot(q, 7)).toBeNull(); // actual: empty snapshot; channel 7 now exists
    expect(getAllChannelsPauseState(q)).toHaveLength(0); // actual: 8
  });
});

describe('BUG-18 resumeChannel / resumeAllChannels never settle if play() never settles', () => {
  test('resumeChannel settles (or times out with loadTimeoutMs) even if play() hangs', async () => {
    const q = setup({ loadTimeoutMs: 1000 });
    await queueAudio(q, '/a.mp3');
    await flush();
    await pauseChannel(q);
    audioAt(0).playBehavior = 'hang'; // iOS: play() can stay pending while the network stalls
    let settled = false;
    void resumeAllChannels(q).then(() => (settled = true));
    await advance(5000); // even after the item was skipped by the load timeout...
    expect(getQueueLength(q)).toBe(1); // (started items get no load timer: still queued)
    expect(settled).toBe(true); // actual: false, the await hangs forever
  });
});

describe('BUG-19 destroyAllChannels ("reset the queue completely") keeps the global volume', () => {
  test('global volume is back to 1 after destroyAllChannels', async () => {
    const q = setup();
    await setGlobalVolume(q, 0.2);
    await destroyAllChannels(q);
    expect(getGlobalVolume(q)).toBe(1); // actual: 0.2 (default-queue tests reset it by hand)
  });
});
