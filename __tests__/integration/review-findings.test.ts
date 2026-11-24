/**
 * @fileoverview Regression tests for every issue found in the v2 adversarial review (F1-F11).
 * In v2 each of these scenarios misbehaved; each test asserts the fixed behaviour.
 */
import {
  createAudioQueue,
  destroyChannel,
  getChannelVolume,
  getCurrentAudioInfo,
  getQueueLength,
  getQueueSnapshot,
  isChannelPaused,
  onAudioError,
  onAudioStart,
  onQueueChange,
  pauseWithFade,
  queueAudio,
  resumeWithFade,
  setChannelVolume,
  setGlobalVolume,
  setVolumeDucking,
  stopAllAudio
} from '../../src/queue';
import type { AudioQueue } from '../../src/queue';
import { AudioErrorType, FadeType } from '../../src/types';
import type { QueueConfig } from '../../src/types';
import {
  DESKTOP_UA,
  FakeAudio,
  FakeAudioContext,
  IPHONE_UA,
  advance,
  audioAt,
  callArg,
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

afterEach(() => jest.useRealTimers());

describe('F1: channel bookkeeping never crashes', () => {
  test('subscribing on channel 1 before using channel 0', async () => {
    const queue = setup();
    onAudioStart(queue, 1, jest.fn());
    await expect(queueAudio(queue, '/a.mp3', 0)).resolves.toBeDefined();
  });

  test('setting volume on channel 2 before using channel 0', async () => {
    const queue = setup();
    await setChannelVolume(queue, 2, 0.5);
    await expect(queueAudio(queue, '/a.mp3', 0)).resolves.toBeDefined();
  });

  test('re-queueing on a destroyed channel', async () => {
    const queue = setup();
    onAudioError(queue, 1, jest.fn());
    await destroyChannel(queue, 0);
    await expect(queueAudio(queue, '/a.mp3', 0)).resolves.toBeDefined();
  });

  test('NaN and fractional channels are rejected with a clear RangeError', async () => {
    const queue = setup();
    await expect(queueAudio(queue, '/a.mp3', NaN)).rejects.toThrow(RangeError);
    await expect(queueAudio(queue, '/a.mp3', 1.5)).rejects.toThrow(RangeError);
  });
});

describe('F2: legitimate sources are accepted', () => {
  test.each([
    'blob:http://localhost/9b1c-uuid',
    '../sounds/beep.mp3',
    'data:audio/wav;base64,UklGRiQAAABXQVZF',
    'capacitor://localhost/beep.mp3'
  ])('%s', async (url) => {
    await expect(queueAudio(setup(), url)).resolves.toBeDefined();
  });
});

describe('F3: file names are plain text', () => {
  test('no HTML entities in event payloads', async () => {
    const queue = setup();
    const names: string[] = [];
    onQueueChange(queue, 0, (s) => names.push(s.items[0]?.fileName ?? ''));
    await queueAudio(queue, 'rock%20%26%20roll.mp3');
    expect(names[0]).toBe('rock & roll.mp3');
  });
});

describe('F4: one failure, one report; autoplay blocking keeps the queue', () => {
  test('a blocked play() is reported exactly once', async () => {
    FakeAudio.defaultPlayBehavior = 'not-allowed';
    const queue = setup();
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    await queueAudio(queue, '/a.mp3');
    await advance(60000, 1000);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  test('sounds queued before a user gesture survive and play after it', async () => {
    FakeAudio.defaultPlayBehavior = 'not-allowed';
    const queue = setup();
    for (const n of ['a', 'b', 'c', 'd']) await queueAudio(queue, `/${n}.mp3`);
    await advance(400000, 10000);
    expect(getQueueLength(queue)).toBe(4);
    FakeAudio.defaultPlayBehavior = 'resolve';
    document.dispatchEvent(new Event('touchend'));
    await flush();
    expect(getCurrentAudioInfo(queue)?.isPlaying).toBe(true);
  });
});

describe('F5: a failing waiting item cannot hijack the channel', () => {
  test('it is never played and the current item is never evicted', async () => {
    const queue = setup();
    await queueAudio(queue, '/one.mp3');
    await queueAudio(queue, '/two.mp3');
    await flush();
    const [one, two] = [audioAt(0), audioAt(1)];
    two.playBehavior = 'not-supported';
    two.fail(4);
    await advance(100000, 10000);
    expect(two.playCalls).toBe(0);
    expect(one.paused).toBe(false);
    expect(getQueueSnapshot(queue)?.items.map((i) => i.fileName)).toEqual(['one.mp3']);
  });
});

describe('F6: nothing plays after stop', () => {
  test('a failed item does not come back after stopAllAudio', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    const audio = audioAt(0);
    audio.fail(2, 'network error');
    await stopAllAudio(queue);
    const plays = audio.playCalls;
    await advance(100000, 10000);
    expect(audio.playCalls).toBe(plays);
    expect(audio.paused).toBe(true);
  });
});

describe('F7: a network stall is not an error', () => {
  test('stalled does not restart or skip the track', async () => {
    const queue = setup();
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    await queueAudio(queue, '/a.mp3');
    await flush();
    const audio = audioAt(0);
    audio.currentTime = 5;
    audio.fire('stalled');
    await advance(10000, 1000);
    expect(audio.loadCalls).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    expect(getQueueLength(queue)).toBe(1);
  });
});

describe('F8: no hangs and no zombie fades', () => {
  test('pause-with-fade then resume-with-fade mid-fade leaves the audio playing', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    await flush();
    const pause = pauseWithFade(queue, FadeType.Linear, 0, 400);
    await advance(50);
    const resume = resumeWithFade(queue, FadeType.Linear, 0, 400);
    await advance(1600);
    await Promise.all([pause, resume]);
    expect(audioAt(0).paused).toBe(false);
    expect(isChannelPaused(queue, 0)).toBe(false);
  });

  test('ducking does not delay the priority sound, even with timers throttled', async () => {
    const queue = setup();
    setVolumeDucking(queue, { duckingVolume: 0.2, priorityChannel: 1, priorityVolume: 1 });
    await queueAudio(queue, '/music.mp3', 0);
    await queueAudio(queue, '/notify.mp3', 1);
    expect(audioAt(1).playCalls).toBe(1);
  });

  test('an item that never loads is skipped after loadTimeoutMs', async () => {
    FakeAudio.defaultPlayBehavior = 'hang';
    const queue = setup({ loadTimeoutMs: 15000 });
    const item = await queueAudio(queue, '/a.mp3');
    await advance(16000, 1000);
    await expect(item.finished).resolves.toBe('error');
  });
});

describe('F9: volume factors are independent', () => {
  test('per-item volume does not change the channel volume', async () => {
    const queue = setup();
    await setChannelVolume(queue, 0, 0.8);
    await queueAudio(queue, '/quiet.mp3', 0, { volume: 0.1 });
    expect(getChannelVolume(queue, 0)).toBe(0.8);
  });

  test('global volume applies to items with an explicit volume', async () => {
    const queue = setup();
    await setGlobalVolume(queue, 0.5);
    await queueAudio(queue, '/a.mp3', 0, { volume: 0.4 });
    expect(audioAt(0).volume).toBeCloseTo(0.2);
  });

  test('a volume transition on an idle channel is applied', async () => {
    const queue = setup();
    onQueueChange(queue, 0, jest.fn());
    const done = setChannelVolume(queue, 0, 0.3, 200);
    await advance(300);
    await done;
    expect(getChannelVolume(queue, 0)).toBeCloseTo(0.3);
  });
});

describe('F10: listeners are independent', () => {
  test('removing one component listener keeps the others', async () => {
    const queue = setup();
    const a = jest.fn();
    const b = jest.fn();
    const unsubscribeA = onQueueChange(queue, 0, a);
    onQueueChange(queue, 0, b);
    unsubscribeA();
    await queueAudio(queue, '/x.mp3');
    expect(b).toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();
  });
});

describe('F11: resource use is bounded', () => {
  test('a long queue creates only the elements it needs', async () => {
    const queue = setup();
    for (let i = 0; i < 50; i++) await queueAudio(queue, `/t${i}.mp3`);
    expect(FakeAudio.instances.length).toBe(2);
  });

  test('finished items release their media', async () => {
    const queue = setup();
    await queueAudio(queue, '/a.mp3');
    await flush();
    const audio = audioAt(0);
    audio.finish();
    await flush();
    expect(audio.src).toBe('');
    expect(audio.loadCalls).toBe(1);
  });

  test('one AudioContext is shared by all channels', async () => {
    installFakeAudioContext();
    const queue = setup({ webAudio: 'force' });
    for (let channel = 0; channel < 5; channel++) await queueAudio(queue, '/a.mp3', channel);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  test('iOS cross-origin audio without CORS is not routed into silence', async () => {
    installFakeAudioContext();
    setUserAgent(IPHONE_UA);
    const queue = setup();
    await queueAudio(queue, 'https://cdn.example.com/a.mp3');
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  test('errors are classified from the browser error name, not message text', async () => {
    FakeAudio.defaultPlayBehavior = 'not-allowed';
    const queue = setup();
    const errors = jest.fn();
    onAudioError(queue, 0, errors);
    await queueAudio(queue, '/a.mp3');
    await flush();
    expect(callArg(errors)).toMatchObject({ errorType: AudioErrorType.AutoplayBlocked });
  });
});
