/**
 * @fileoverview Realistic test doubles for HTMLAudioElement and AudioContext.
 * Events only fire when the test (or the simulated browser behaviour below) fires them, and
 * nothing replaces global timers, so timing bugs are visible to tests.
 */

/** What `play()` does. */
export type PlayBehavior =
  | 'resolve'
  | 'resolve-silently'
  | 'not-allowed'
  | 'not-supported'
  | 'abort'
  | 'generic-error'
  | 'hang'
  | 'throw-sync';

const makeDomError = (name: string, message: string): Error => {
  const error = new Error(message);
  error.name = name;
  return error;
};

/** Fake `<audio>` element. */
export class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  static defaultPlayBehavior: PlayBehavior = 'resolve';
  /** When true, currentTime advances with (fake) time while playing, like a real media clock. */
  static mediaClock: boolean = false;
  /** The next this-many seeks are ignored, like a file served without HTTP Range support. */
  static ignoredSeeks: number = 0;

  crossOrigin: string | null = null;
  duration: number = NaN;
  ended: boolean = false;
  error: { code: number; message: string } | null = null;
  loadCalls: number = 0;
  loop: boolean = false;
  pauseCalls: number = 0;
  paused: boolean = true;
  playBehavior: PlayBehavior | undefined;
  playCalls: number = 0;
  playbackRate: number = 1;
  preload: string = '';
  preservesPitch: boolean = false;
  readyState: number = 0;
  volume: number = 1;
  private source: string = '';
  private baseTime: number = 0;
  private clockStartedAt: number | undefined;

  constructor(src?: string) {
    super();
    if (src !== undefined) this.src = src;
    FakeAudio.instances.push(this);
  }

  /** Resets the instance registry and default behaviour. */
  static reset(): void {
    FakeAudio.instances = [];
    FakeAudio.defaultPlayBehavior = 'resolve';
    FakeAudio.mediaClock = false;
    FakeAudio.ignoredSeeks = 0;
  }

  get currentTime(): number {
    if (this.clockStartedAt === undefined) return this.baseTime;
    const elapsed = (performance.now() - this.clockStartedAt) / 1000;
    const time = this.baseTime + elapsed * this.playbackRate;
    return Number.isFinite(this.duration) ? Math.min(time, this.duration) : time;
  }

  set currentTime(value: number) {
    if (FakeAudio.ignoredSeeks > 0) {
      FakeAudio.ignoredSeeks--;
      return;
    }
    this.baseTime = value;
    if (this.clockStartedAt !== undefined) this.clockStartedAt = performance.now();
    if (FakeAudio.mediaClock) this.fire('seeked');
  }

  private runClock(running: boolean): void {
    if (!FakeAudio.mediaClock) return;
    if (running && this.clockStartedAt === undefined) {
      this.clockStartedAt = performance.now();
    } else if (!running && this.clockStartedAt !== undefined) {
      this.baseTime = this.currentTime;
      this.clockStartedAt = undefined;
    }
  }

  get src(): string {
    return this.source;
  }

  set src(value: string) {
    if (value === '' || typeof document === 'undefined') {
      this.source = value;
    } else {
      this.source = new URL(value, document.baseURI).href;
    }
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.source = '';
  }

  load(): void {
    this.loadCalls++;
  }

  pause(): void {
    this.pauseCalls++;
    if (this.paused) return;
    this.runClock(false);
    this.paused = true;
    this.fire('pause');
  }

  play(): Promise<void> {
    this.playCalls++;
    const behavior = this.playBehavior ?? FakeAudio.defaultPlayBehavior;
    switch (behavior) {
      case 'resolve':
        this.markPlaying();
        this.ended = false;
        void Promise.resolve().then(() => this.startPlaying());
        return Promise.resolve();
      case 'resolve-silently':
        this.markPlaying();
        return Promise.resolve();
      case 'not-allowed':
        return Promise.reject(makeDomError('NotAllowedError', 'play() requires a user gesture'));
      case 'not-supported':
        return Promise.reject(makeDomError('NotSupportedError', 'No supported source'));
      case 'abort':
        return Promise.reject(makeDomError('AbortError', 'Interrupted by pause()'));
      case 'generic-error':
        return Promise.reject(makeDomError('WeirdError', 'Something odd'));
      case 'hang':
        this.markPlaying();
        return new Promise<void>(() => undefined);
      case 'throw-sync':
        throw makeDomError('InvalidStateError', 'Synchronous failure');
    }
  }

  /** Like a browser: leaving the paused state fires `play` (asynchronously). */
  private markPlaying(): void {
    if (!this.paused) return;
    this.paused = false;
    void Promise.resolve().then(() => this.fire('play'));
  }

  // ------------------------------------------------------------ simulation helpers

  /** Simulates the OS or browser pausing playback (phone call, unplugged headphones). */
  externalPause(): void {
    this.runClock(false);
    this.paused = true;
    this.fire('pause');
  }

  /** Simulates the OS resuming playback (lock-screen play button). */
  externalPlay(): void {
    this.paused = false;
    this.fire('play');
    this.fire('playing');
  }

  /** Fires an event of the given type. */
  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }

  /** Simulates metadata loading and playback starting. */
  startPlaying(duration: number = 10): void {
    if (Number.isNaN(this.duration)) this.duration = duration;
    this.readyState = 4;
    this.paused = false;
    this.runClock(true);
    this.fire('loadedmetadata');
    this.fire('playing');
  }

  /** Simulates reaching the end the way browsers do: `pause` fires just before `ended`. */
  finish(): void {
    this.currentTime = this.duration;
    this.ended = true;
    if (!this.paused) {
      this.paused = true;
      this.fire('pause');
    }
    this.fire('ended');
  }

  /** Simulates a media error (`code` per MediaError). */
  fail(code: number = 4, message: string = 'MEDIA_ERR_SRC_NOT_SUPPORTED'): void {
    this.error = { code, message };
    this.fire('error');
  }

  /** Simulates playback progress. */
  tick(seconds: number): void {
    this.currentTime = seconds;
    this.fire('timeupdate');
  }
}

/** Fake AudioParam. */
export class FakeAudioParam {
  cancelScheduledValues: jest.Mock = jest.fn();
  value: number = 1;
}

/** Fake AudioNode. */
export class FakeAudioNode {
  connect: jest.Mock = jest.fn();
  disconnect: jest.Mock = jest.fn();
  gain: FakeAudioParam = new FakeAudioParam();
}

/** Fake AudioContext. */
export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static failSourceCreation: boolean = false;

  currentTime: number = 0;
  destination: object = {};
  sources: FakeAudioNode[] = [];
  gains: FakeAudioNode[] = [];
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  close: jest.Mock = jest.fn(async () => {
    this.state = 'closed';
  });
  resume: jest.Mock = jest.fn(async () => {
    this.state = 'running';
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  static reset(): void {
    FakeAudioContext.instances = [];
    FakeAudioContext.failSourceCreation = false;
  }

  createMediaElementSource(_element: unknown): FakeAudioNode {
    if (FakeAudioContext.failSourceCreation) throw new Error('InvalidStateError');
    const node = new FakeAudioNode();
    this.sources.push(node);
    return node;
  }

  createGain(): FakeAudioNode {
    const node = new FakeAudioNode();
    this.gains.push(node);
    return node;
  }
}

interface Globals {
  Audio?: unknown;
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
}

/** Installs FakeAudio as the global `Audio`. */
export const installFakeAudio = (): void => {
  FakeAudio.reset();
  (globalThis as Globals).Audio = FakeAudio;
};

/** Installs FakeAudioContext as the global `AudioContext`. */
export const installFakeAudioContext = (): void => {
  FakeAudioContext.reset();
  (globalThis as Globals).AudioContext = FakeAudioContext;
};

/** Removes the Web Audio globals. */
export const removeAudioContext = (): void => {
  delete (globalThis as Globals).AudioContext;
  delete (globalThis as Globals).webkitAudioContext;
};

/** Stubs URL.createObjectURL / revokeObjectURL (jsdom does not implement them). */
export const installObjectUrls = (): { create: jest.Mock; revoke: jest.Mock } => {
  let next = 0;
  const create = jest.fn(() => `blob:http://localhost/object-${++next}`);
  const revoke = jest.fn();
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
  return { create, revoke };
};

/** Sets document.hidden and fires visibilitychange. */
export const setPageHidden = (hidden: boolean): void => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
};

/** Lets pending promise callbacks run (works with fake timers). */
export const flush = async (rounds: number = 10): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

/** Advances fake timers in steps, flushing promises between steps. */
export const advance = async (ms: number, step: number = 16): Promise<void> => {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    jest.advanceTimersByTime(Math.min(step, ms - elapsed));
    await flush(3);
  }
};

/** Returns the n-th created FakeAudio, failing loudly if it does not exist. */
export const audioAt = (index: number): FakeAudio => {
  const audio = FakeAudio.instances[index];
  if (!audio) throw new Error(`No FakeAudio at index ${index}`);
  return audio;
};

/** Sets navigator.userAgent / maxTouchPoints for device detection tests. */
export const setUserAgent = (userAgent: string, maxTouchPoints: number = 0): void => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: maxTouchPoints });
};

/** iPhone user agent. */
export const IPHONE_UA: string =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
/** Desktop Chrome user agent. */
export const DESKTOP_UA: string =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
