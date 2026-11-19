import {
  MAX_TIMER_MS,
  assertChannelNumber,
  clampUnit,
  extractFileName,
  now,
  secondsToMs,
  settleWithin
} from '../src/utils';

describe('clampUnit', () => {
  test.each([
    [0.5, 0.5],
    [-1, 0],
    [2, 1],
    [0, 0],
    [1, 1]
  ])('clamps %p to %p', (input, expected) => {
    expect(clampUnit(input)).toBe(expected);
  });

  test('uses the fallback for NaN, Infinity and non-numbers', () => {
    expect(clampUnit(NaN, 0.3)).toBe(0.3);
    expect(clampUnit(Infinity, 0.4)).toBe(0.4);
    expect(clampUnit('1' as unknown as number)).toBe(1);
  });
});

describe('assertChannelNumber', () => {
  test('accepts integers in range', () => {
    expect(() => assertChannelNumber(0, 64)).not.toThrow();
    expect(() => assertChannelNumber(63, 64)).not.toThrow();
  });

  test.each([-1, 64, 1.5, NaN, Infinity])('rejects %p with a RangeError', (value) => {
    expect(() => assertChannelNumber(value, 64)).toThrow(RangeError);
  });

  test('error message names the allowed range', () => {
    expect(() => assertChannelNumber(9, 4)).toThrow('from 0 to 3');
  });
});

describe('extractFileName', () => {
  test('returns the decoded last path segment without query or hash', () => {
    expect(extractFileName('https://cdn.example.com/a/rock%20%26%20roll.mp3?v=2#t=1')).toBe(
      'rock & roll.mp3'
    );
  });

  test('does not HTML-escape (escaping belongs to the renderer)', () => {
    expect(extractFileName('/sfx/<b>.mp3')).toBe('<b>.mp3');
  });

  test('handles relative paths', () => {
    expect(extractFileName('../sounds/beep.wav')).toBe('beep.wav');
  });

  test('returns the raw segment when decoding fails', () => {
    expect(extractFileName('/bad%E0%A4%A.mp3')).toBe('bad%E0%A4%A.mp3');
  });

  test('labels data URIs instead of returning their payload', () => {
    expect(extractFileName('data:audio/wav;base64,AAAA')).toBe('data-uri');
  });

  test.each(['', '/folder/', undefined as unknown as string])('returns unknown for %p', (url) => {
    expect(extractFileName(url)).toBe('unknown');
  });
});

describe('now', () => {
  test('is monotonic', () => {
    const a = now();
    const b = now();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  test('falls back to Date.now without performance', () => {
    const original = globalThis.performance;
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: undefined });
    try {
      expect(Math.abs(now() - Date.now())).toBeLessThan(1000);
    } finally {
      Object.defineProperty(globalThis, 'performance', {
        configurable: true,
        value: original,
        writable: true
      });
    }
  });
});

describe('secondsToMs', () => {
  test('converts seconds and maps non-finite values to 0', () => {
    expect(secondsToMs(1.5)).toBe(1500);
    expect(secondsToMs(NaN)).toBe(0);
    expect(secondsToMs(Infinity)).toBe(0);
  });
});

describe('settleWithin', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('MAX_TIMER_MS is the largest delay timers accept', () => {
    expect(MAX_TIMER_MS).toBe(2147483647);
  });

  test('resolves when the promise resolves or rejects, before the limit', async () => {
    await expect(settleWithin(Promise.resolve(1), 1000)).resolves.toBeUndefined();
    await expect(settleWithin(Promise.reject(new Error('x')), 1000)).resolves.toBeUndefined();
  });

  test('resolves after the limit when the promise never settles', async () => {
    let done = false;
    void settleWithin(new Promise(() => undefined), 500).then(() => (done = true));
    jest.advanceTimersByTime(499);
    await Promise.resolve();
    expect(done).toBe(false);
    jest.advanceTimersByTime(1);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(done).toBe(true);
  });

  test('a limit of 0 waits for the promise without a timer', async () => {
    const spy = jest.spyOn(globalThis, 'setTimeout');
    await settleWithin(Promise.resolve(), 0);
    expect(spy).not.toHaveBeenCalled();
  });
});
