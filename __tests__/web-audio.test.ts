import {
  WebAudioEngine,
  describeWebAudioSupport,
  getAudioContextClass,
  isIOSDevice,
  isWebAudioSupported,
  shouldUseWebAudio
} from '../src/web-audio';
import {
  DESKTOP_UA,
  FakeAudio,
  FakeAudioContext,
  IPHONE_UA,
  flush,
  installFakeAudioContext,
  removeAudioContext,
  setUserAgent
} from './helpers/fake-audio';

const element = (): HTMLAudioElement => new FakeAudio('/a.mp3') as unknown as HTMLAudioElement;

beforeEach(() => {
  installFakeAudioContext();
  setUserAgent(DESKTOP_UA);
});

afterEach(() => removeAudioContext());

describe('isIOSDevice', () => {
  test('detects iPhone', () => {
    setUserAgent(IPHONE_UA);
    expect(isIOSDevice()).toBe(true);
  });

  test('detects iPadOS reporting as a Mac with touch', () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5);
    expect(isIOSDevice()).toBe(true);
  });

  test('desktop is not iOS', () => {
    expect(isIOSDevice()).toBe(false);
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0);
    expect(isIOSDevice()).toBe(false);
  });

  test('is false without navigator', () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
    try {
      expect(isIOSDevice()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: original });
    }
  });
});

describe('support detection', () => {
  test('getAudioContextClass prefers AudioContext and falls back to webkitAudioContext', () => {
    expect(getAudioContextClass()).toBe(FakeAudioContext);
    removeAudioContext();
    expect(getAudioContextClass()).toBeUndefined();
    (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext = FakeAudioContext;
    expect(getAudioContextClass()).toBe(FakeAudioContext);
  });

  test('isWebAudioSupported follows the globals', () => {
    expect(isWebAudioSupported()).toBe(true);
    removeAudioContext();
    expect(isWebAudioSupported()).toBe(false);
  });

  test('shouldUseWebAudio: off never, force always, auto only on iOS', () => {
    expect(shouldUseWebAudio('off')).toBe(false);
    expect(shouldUseWebAudio('force')).toBe(true);
    expect(shouldUseWebAudio('auto')).toBe(false);
    setUserAgent(IPHONE_UA);
    expect(shouldUseWebAudio('auto')).toBe(true);
    removeAudioContext();
    expect(shouldUseWebAudio('force')).toBe(false);
  });

  test.each([
    ['off', DESKTOP_UA, true, /disabled/],
    ['force', DESKTOP_UA, true, /forced/],
    ['auto', IPHONE_UA, true, /iOS detected/],
    ['auto', DESKTOP_UA, true, /HTMLAudioElement volume/],
    ['auto', DESKTOP_UA, false, /not available/]
  ] as const)('describeWebAudioSupport(%s) explains itself', (mode, ua, available, reason) => {
    setUserAgent(ua);
    if (!available) removeAudioContext();
    const support = describeWebAudioSupport(mode);
    expect(support.available).toBe(available);
    expect(support.reason).toMatch(reason);
    expect(support.usingWebAudio).toBe(shouldUseWebAudio(mode));
  });
});

describe('WebAudioEngine', () => {
  test('creates one shared context lazily for many elements', () => {
    const engine = new WebAudioEngine();
    expect(FakeAudioContext.instances).toHaveLength(0);
    const a = engine.connect(element(), 0.5);
    const b = engine.connect(element(), 1);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(a?.gain.gain.value).toBe(0.5);
    expect(b?.gain.gain.value).toBe(1);
    expect(a?.source.connect).toHaveBeenCalledWith(a?.gain);
  });

  test('resumes a suspended context when connecting', async () => {
    const engine = new WebAudioEngine();
    engine.connect(element(), 1);
    const context = FakeAudioContext.instances[0] as FakeAudioContext;
    expect(context.resume).toHaveBeenCalled();
    await flush();
    engine.resume();
    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  test('resume swallows rejections', async () => {
    const engine = new WebAudioEngine();
    engine.connect(element(), 1);
    const context = FakeAudioContext.instances[0] as FakeAudioContext;
    context.state = 'suspended';
    context.resume.mockRejectedValueOnce(new Error('needs gesture'));
    expect(() => engine.resume()).not.toThrow();
    await flush();
  });

  test('connect returns undefined when there is no Web Audio or node creation fails', () => {
    const engine = new WebAudioEngine();
    FakeAudioContext.failSourceCreation = true;
    expect(engine.connect(element(), 1)).toBeUndefined();
    removeAudioContext();
    expect(new WebAudioEngine().connect(element(), 1)).toBeUndefined();
  });

  test('connect returns undefined when the context constructor throws', () => {
    (globalThis as { AudioContext?: unknown }).AudioContext = class {
      constructor() {
        throw new Error('too many contexts');
      }
    };
    expect(new WebAudioEngine().connect(element(), 1)).toBeUndefined();
  });

  test('setGain cancels scheduled ramps and sets the value', () => {
    const engine = new WebAudioEngine();
    const route = engine.connect(element(), 1);
    if (!route) throw new Error('expected a route');
    engine.setGain(route, 0.25);
    expect(route.gain.gain.value).toBe(0.25);
    expect(
      (route.gain.gain as unknown as { cancelScheduledValues: jest.Mock }).cancelScheduledValues
    ).toHaveBeenCalled();
  });

  test('disconnect detaches both nodes and tolerates repeated calls', () => {
    const engine = new WebAudioEngine();
    const route = engine.connect(element(), 1);
    if (!route) throw new Error('expected a route');
    engine.disconnect(route);
    expect(route.source.disconnect).toHaveBeenCalled();
    expect(route.gain.disconnect).toHaveBeenCalled();
    (route.source.disconnect as jest.Mock).mockImplementation(() => {
      throw new Error('already');
    });
    expect(() => engine.disconnect(route)).not.toThrow();
  });

  test('close closes the context; the next connect creates a new one', () => {
    const engine = new WebAudioEngine();
    engine.connect(element(), 1);
    const first = FakeAudioContext.instances[0] as FakeAudioContext;
    engine.close();
    expect(first.close).toHaveBeenCalled();
    engine.close();
    engine.connect(element(), 1);
    expect(FakeAudioContext.instances).toHaveLength(2);
  });

  test('close does not close a context that is already closed (N08)', () => {
    const engine = new WebAudioEngine();
    engine.connect(element(), 1);
    const context = FakeAudioContext.instances[0] as FakeAudioContext;
    context.state = 'closed';
    engine.close();
    expect(context.close).not.toHaveBeenCalled();
  });

  test('resume also wakes an iOS "interrupted" context (BUG-11)', () => {
    const engine = new WebAudioEngine();
    engine.connect(element(), 1);
    const context = FakeAudioContext.instances[0] as FakeAudioContext;
    (context as unknown as { state: string }).state = 'interrupted';
    context.resume.mockClear();
    engine.resume();
    expect(context.resume).toHaveBeenCalledTimes(1);
  });
});
