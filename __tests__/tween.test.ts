import { EASINGS, TWEEN_STEP_MS, startTween } from '../src/tween';
import { EasingType } from '../src/types';
import { flush } from './helpers/fake-audio';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('EASINGS', () => {
  test.each(Object.values(EasingType))('%s starts at 0 and ends at 1', (type) => {
    const ease = EASINGS[type];
    expect(ease(0)).toBeCloseTo(0);
    expect(ease(1)).toBeCloseTo(1);
  });

  test('curves differ in the middle', () => {
    expect(EASINGS[EasingType.EaseIn](0.5)).toBeLessThan(0.5);
    expect(EASINGS[EasingType.EaseOut](0.5)).toBeGreaterThan(0.5);
    expect(EASINGS[EasingType.EaseInOut](0.25)).toBeLessThan(0.25);
    expect(EASINGS[EasingType.EaseInOut](0.75)).toBeGreaterThan(0.75);
  });
});

describe('startTween', () => {
  test('reaches the target after the duration and resolves true', async () => {
    const values: number[] = [];
    const tween = startTween({
      duration: 100,
      easing: EasingType.Linear,
      from: 0,
      onUpdate: (v) => values.push(v),
      to: 1
    });
    let result: boolean | undefined;
    void tween.done.then((r) => (result = r));
    jest.advanceTimersByTime(120);
    await flush();
    expect(result).toBe(true);
    expect(values[values.length - 1]).toBe(1);
    expect(values.length).toBeGreaterThan(3);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] as number);
    }
  });

  test('cancel stops updates and resolves false', async () => {
    const onUpdate = jest.fn();
    const tween = startTween({
      duration: 100,
      easing: EasingType.Linear,
      from: 0,
      onUpdate,
      to: 1
    });
    jest.advanceTimersByTime(TWEEN_STEP_MS * 2);
    tween.cancel();
    const calls = onUpdate.mock.calls.length;
    jest.advanceTimersByTime(200);
    expect(onUpdate.mock.calls.length).toBe(calls);
    await expect(tween.done).resolves.toBe(false);
  });

  test('cancel after completion keeps the true result', async () => {
    const tween = startTween({
      duration: 10,
      easing: EasingType.Linear,
      from: 0,
      onUpdate: jest.fn(),
      to: 1
    });
    jest.advanceTimersByTime(50);
    tween.cancel();
    await expect(tween.done).resolves.toBe(true);
  });

  test.each([0, -5, NaN])('duration %p jumps straight to the target', async (duration) => {
    const onUpdate = jest.fn();
    const tween = startTween({ duration, easing: EasingType.Linear, from: 0.2, onUpdate, to: 0.8 });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(0.8);
    tween.cancel();
    await expect(tween.done).resolves.toBe(true);
  });

  test('equal from and to completes immediately', async () => {
    const onUpdate = jest.fn();
    const tween = startTween({
      duration: 500,
      easing: EasingType.EaseIn,
      from: 1,
      onUpdate,
      to: 1
    });
    await expect(tween.done).resolves.toBe(true);
    expect(onUpdate).toHaveBeenCalledWith(1);
  });

  test('unknown easing falls back to linear', async () => {
    const values: number[] = [];
    const tween = startTween({
      duration: 100,
      easing: 'bogus' as EasingType,
      from: 0,
      onUpdate: (v) => values.push(v),
      to: 1
    });
    jest.advanceTimersByTime(200);
    await expect(tween.done).resolves.toBe(true);
    expect(values[values.length - 1]).toBe(1);
  });

  test('finishes on time even if timers are throttled (background tab)', async () => {
    const onUpdate = jest.fn();
    const tween = startTween({
      duration: 100,
      easing: EasingType.Linear,
      from: 0,
      onUpdate,
      to: 1
    });
    // Throttled tabs run timers about once per second; progress is time-based, so one late step
    // is enough to finish.
    jest.advanceTimersByTime(1000);
    await expect(tween.done).resolves.toBe(true);
    expect(onUpdate).toHaveBeenLastCalledWith(1);
  });
});
