/**
 * @fileoverview Tests for preloading: files downloaded into memory and played from object URLs.
 */
import { createAudioQueue } from '../src/audio-queue';
import type { AudioQueue } from '../src/audio-queue';
import { getDefaultAudioQueue } from '../src/default-queue';
import {
  isAudioPreloaded,
  preloadAudio,
  releasePreloadedAudio,
  withMediaType
} from '../src/preload';
import type { QueueConfig } from '../src/types';
import {
  DESKTOP_UA,
  FakeAudioContext,
  IPHONE_UA,
  advance,
  audioAt,
  flush,
  installFakeAudio,
  installFakeAudioContext,
  installFakeFetch,
  installObjectUrls,
  removeAudioContext,
  removeFetch,
  setUserAgent
} from './helpers/fake-audio';
import type { FakeFetch } from './helpers/fake-audio';

const BASE = 'http://localhost';
const setup = (config: Partial<QueueConfig> = {}): AudioQueue =>
  createAudioQueue({ logger: null, ...config });

let net: FakeFetch;
let urls: ReturnType<typeof installObjectUrls>;

beforeEach(() => {
  jest.useFakeTimers();
  installFakeAudio();
  removeAudioContext();
  setUserAgent(DESKTOP_UA);
  net = installFakeFetch();
  urls = installObjectUrls();
});

afterEach(() => {
  jest.useRealTimers();
  removeFetch();
});

const preloaded = async (queue: AudioQueue, path: string): Promise<void> => {
  const done = preloadAudio(path, queue);
  await flush();
  net.respond(`${BASE}${path}`);
  await done;
};

describe('preloadAudio', () => {
  test('downloads files and reports size; queued items then play from memory', async () => {
    const queue = setup();
    const done = preloadAudio(['/sfx/coin.mp3', 'sfx/jump.mp3'], queue);
    await flush();
    expect(net.calls).toEqual([`${BASE}/sfx/coin.mp3`, `${BASE}/sfx/jump.mp3`]);
    net.respond(`${BASE}/sfx/coin.mp3`, 'abc');
    net.respond(`${BASE}/sfx/jump.mp3`, 'abcdef');
    await expect(done).resolves.toEqual([
      { bytes: 3, ok: true, src: `${BASE}/sfx/coin.mp3` },
      { bytes: 6, ok: true, src: `${BASE}/sfx/jump.mp3` }
    ]);
    expect(isAudioPreloaded('/sfx/coin.mp3', queue)).toBe(true);

    const item = await queue.queueAudio('/sfx/coin.mp3');
    expect(item.src).toBe(`${BASE}/sfx/coin.mp3`);
    expect(queue.getQueueSnapshot()?.items[0]?.fileName).toBe('coin.mp3');
    expect(audioAt(0).src).toBe('blob:http://localhost/object-1');
    expect(queue.getCurrentAudioInfo()?.src).toBe(`${BASE}/sfx/coin.mp3`);
  });

  test('each queued copy gets its own object URL, revoked when that item is released', async () => {
    const queue = setup();
    await preloaded(queue, '/a.mp3');
    await queue.queueAudio('/a.mp3');
    await queue.queueAudio('/a.mp3');
    expect(urls.create).toHaveBeenCalledTimes(2);
    await flush();
    audioAt(0).finish();
    await flush();
    expect(urls.revoke).toHaveBeenCalledTimes(1);
    expect(urls.revoke).toHaveBeenCalledWith('blob:http://localhost/object-1');
  });

  test('a string source is the same as a one-item list, and concurrent preloads share one download', async () => {
    const queue = setup();
    const first = preloadAudio('/a.mp3', queue);
    const second = preloadAudio(['/a.mp3'], queue);
    await flush();
    expect(net.calls).toHaveLength(1);
    net.respond(`${BASE}/a.mp3`);
    await expect(first).resolves.toEqual([{ bytes: 11, ok: true, src: `${BASE}/a.mp3` }]);
    await expect(second).resolves.toEqual([{ bytes: 11, ok: true, src: `${BASE}/a.mp3` }]);
    await expect(preloadAudio('/a.mp3', queue)).resolves.toEqual([
      { bytes: 11, ok: true, src: `${BASE}/a.mp3` }
    ]);
    expect(net.calls).toHaveLength(1);
  });

  test('HTTP errors, network errors and timeouts are reported, never thrown', async () => {
    const queue = setup({ loadTimeoutMs: 1000 });
    const done = preloadAudio(['/missing.mp3', '/offline.mp3', '/slow.mp3'], queue);
    await flush();
    net.respond(`${BASE}/missing.mp3`, '', 404);
    net.fail(`${BASE}/offline.mp3`);
    await advance(1000, 100);
    const [missing, offline, slow] = await done;
    expect(missing).toMatchObject({ bytes: 0, ok: false, src: `${BASE}/missing.mp3` });
    expect(missing?.error?.message).toMatch(/HTTP 404/);
    expect(offline?.error?.message).toBe('Failed to fetch');
    expect(slow?.error?.name).toBe('AbortError');
    expect(isAudioPreloaded('/missing.mp3', queue)).toBe(false);
  });

  test('a failed preload can be retried, and the file still plays from the network', async () => {
    const queue = setup();
    const done = preloadAudio('/a.mp3', queue);
    await flush();
    net.fail(`${BASE}/a.mp3`);
    await done;
    await queue.queueAudio('/a.mp3');
    expect(audioAt(0).src).toBe(`${BASE}/a.mp3`);
    void preloadAudio('/a.mp3', queue);
    await flush();
    expect(net.calls).toHaveLength(2);
  });

  test('loadTimeoutMs 0 means downloads never time out', async () => {
    const queue = setup({ loadTimeoutMs: 0 });
    const done = preloadAudio('/slow.mp3', queue);
    await advance(60000, 1000);
    net.respond(`${BASE}/slow.mp3`);
    await expect(done).resolves.toEqual([{ bytes: 11, ok: true, src: `${BASE}/slow.mp3` }]);
  });

  test('without fetch every result explains that a browser is needed', async () => {
    removeFetch();
    const queue = setup();
    const [result] = await preloadAudio('/a.mp3', queue);
    expect(result?.ok).toBe(false);
    expect(result?.error?.message).toMatch(/needs fetch/);
  });

  test('works without AbortController (no timeout)', async () => {
    const original = globalThis.AbortController;
    Object.defineProperty(globalThis, 'AbortController', { configurable: true, value: undefined });
    try {
      const queue = setup({ loadTimeoutMs: 100 });
      const done = preloadAudio('/a.mp3', queue);
      await advance(500, 100);
      net.respond(`${BASE}/a.mp3`);
      await expect(done).resolves.toEqual([{ bytes: 11, ok: true, src: `${BASE}/a.mp3` }]);
    } finally {
      Object.defineProperty(globalThis, 'AbortController', { configurable: true, value: original });
    }
  });
});

describe('the default queue', () => {
  test('is used when no queue is given', async () => {
    const queue = getDefaultAudioQueue();
    const done = preloadAudio('/default.mp3');
    await flush();
    net.respond(`${BASE}/default.mp3`);
    await done;
    expect(isAudioPreloaded('/default.mp3')).toBe(true);
    await queue.queueAudio('/default.mp3');
    expect(audioAt(0).src).toMatch(/^blob:/);
    releasePreloadedAudio('/default.mp3');
    expect(isAudioPreloaded('/default.mp3')).toBe(false);
    releasePreloadedAudio();
    await queue.destroyAllChannels();
  });
});

describe('releasePreloadedAudio', () => {
  test('releases one file; later items stream again while queued items keep their copy', async () => {
    const queue = setup();
    await preloaded(queue, '/a.mp3');
    await preloaded(queue, '/b.mp3');
    await queue.queueAudio('/a.mp3');
    releasePreloadedAudio('/a.mp3', queue);
    expect(isAudioPreloaded('/a.mp3', queue)).toBe(false);
    expect(isAudioPreloaded('/b.mp3', queue)).toBe(true);
    expect(urls.revoke).not.toHaveBeenCalled();
    expect(audioAt(0).src).toBe('blob:http://localhost/object-1');
    await queue.queueAudio('/a.mp3', 1);
    expect(audioAt(1).src).toBe(`${BASE}/a.mp3`);
  });

  test('releasing files that were never preloaded is harmless', () => {
    const queue = setup();
    expect(() => releasePreloadedAudio(['/never.mp3'], queue)).not.toThrow();
    expect(isAudioPreloaded('/never.mp3', queue)).toBe(false);
  });

  test('releases a list, or everything without an argument', async () => {
    const queue = setup();
    await preloaded(queue, '/a.mp3');
    await preloaded(queue, '/b.mp3');
    await preloaded(queue, '/c.mp3');
    releasePreloadedAudio(['/a.mp3', '/b.mp3'], queue);
    expect(isAudioPreloaded('/c.mp3', queue)).toBe(true);
    releasePreloadedAudio(undefined, queue);
    expect(isAudioPreloaded('/c.mp3', queue)).toBe(false);
  });

  test('a download released while running is not kept', async () => {
    const queue = setup();
    const done = preloadAudio('/a.mp3', queue);
    await flush();
    releasePreloadedAudio('/a.mp3', queue);
    net.respond(`${BASE}/a.mp3`);
    await expect(done).resolves.toEqual([{ bytes: 11, ok: true, src: `${BASE}/a.mp3` }]);
    expect(isAudioPreloaded('/a.mp3', queue)).toBe(false);
  });

  test('a download failing after release leaves a newer download alone', async () => {
    const queue = setup();
    const first = preloadAudio('/a.mp3', queue);
    await flush();
    releasePreloadedAudio('/a.mp3', queue);
    const second = preloadAudio('/a.mp3', queue);
    await flush();
    expect(net.calls).toHaveLength(2);
    net.fail(`${BASE}/a.mp3`); // the released, older request
    await expect(first).resolves.toMatchObject([{ ok: false }]);
    net.respond(`${BASE}/a.mp3`); // the newer one
    await expect(second).resolves.toMatchObject([{ ok: true }]);
    expect(isAudioPreloaded('/a.mp3', queue)).toBe(true);
  });

  test('destroyAllChannels releases preloaded files', async () => {
    const queue = setup();
    await preloaded(queue, '/a.mp3');
    await queue.destroyAllChannels();
    expect(isAudioPreloaded('/a.mp3', queue)).toBe(false);
  });
});

describe('preloaded items and the rest of the queue', () => {
  test('repeat one passes the object URL to the replay and revokes it once at the end', async () => {
    const queue = setup();
    await preloaded(queue, '/a.mp3');
    queue.setRepeatMode(0, 'one');
    await queue.queueAudio('/a.mp3');
    await flush();
    audioAt(0).finish();
    await flush();
    expect(urls.create).toHaveBeenCalledTimes(1);
    expect(urls.revoke).not.toHaveBeenCalled();
    queue.setRepeatMode(0, 'off');
    await queue.stopAllAudioInChannel(0);
    expect(urls.revoke).toHaveBeenCalledTimes(1);
  });

  test('on iOS a preloaded file from a CORS-enabled CDN can be routed through Web Audio', async () => {
    installFakeAudioContext();
    setUserAgent(IPHONE_UA);
    const queue = setup({ webAudio: 'auto' });
    await queue.setChannelVolume(0, 0.5);
    await queue.setChannelVolume(1, 0.5);
    const done = preloadAudio('https://cdn.other.com/music.mp3', queue);
    await flush();
    net.respond('https://cdn.other.com/music.mp3');
    await done;
    await queue.queueAudio('https://cdn.other.com/music.mp3');
    await queue.queueAudio('https://cdn.other.com/streamed.mp3', 1);
    const context = FakeAudioContext.instances[0] as FakeAudioContext;
    expect(context.sources).toHaveLength(1);
  });

  test('dedupe compares the original URL, not the object URL', async () => {
    const queue = setup();
    await preloaded(queue, '/a.mp3');
    await queue.queueAudio('/a.mp3', 0, { dedupeMs: 1000 });
    const again = await queue.queueAudio('/a.mp3', 0, { dedupeMs: 1000 });
    await expect(again.finished).resolves.toBe('skipped');
  });
});

describe('withMediaType', () => {
  test('keeps audio and video types', () => {
    const blob = new Blob(['x'], { type: 'audio/ogg' });
    expect(withMediaType(blob, '/a.mp3')).toBe(blob);
    const video = new Blob(['x'], { type: 'video/mp4' });
    expect(withMediaType(video, '/a.mp3')).toBe(video);
  });

  test.each([
    ['/a.mp3', 'audio/mpeg'],
    ['/a.M4A?v=2', 'audio/mp4'],
    ['https://cdn.example.com/b.ogg#t=1', 'audio/ogg'],
    ['/c.wav', 'audio/wav'],
    ['/d.opus', 'audio/ogg'],
    ['/e.webm', 'audio/webm'],
    ['/f.flac', 'audio/flac'],
    ['/g.aac', 'audio/aac']
  ])('retypes a generic download from %s as %s', (url, type) => {
    const blob = new Blob(['x'], { type: 'application/octet-stream' });
    expect(withMediaType(blob, url).type).toBe(type);
  });

  test('leaves unknown or missing extensions alone', () => {
    const blob = new Blob(['x']);
    expect(withMediaType(blob, '/stream')).toBe(blob);
    expect(withMediaType(blob, '/file.xyz')).toBe(blob);
  });

  test('a file served with a generic type is stored with its audio type', async () => {
    const queue = setup();
    const done = preloadAudio('/song.mp3', queue);
    await flush();
    net.respond(`${BASE}/song.mp3`, 'abc', 200, 'application/octet-stream');
    await done;
    await queue.queueAudio('/song.mp3');
    expect((urls.create.mock.calls[0] as unknown[])[0]).toMatchObject({ type: 'audio/mpeg' });
  });
});
