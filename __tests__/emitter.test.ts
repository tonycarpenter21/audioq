/**
 * @fileoverview Tests for the typed event emitter.
 *
 * @dist-skip White-box test: reads Emitter internals, which the build renames.
 */
import { Emitter } from '../src/emitter';

interface Events {
  ping: number;
  pong: string;
}

const make = (): { emitter: Emitter<Events>; onError: jest.Mock } => {
  const onError = jest.fn();
  return { emitter: new Emitter<Events>(onError), onError };
};

describe('Emitter', () => {
  test('on delivers events for its channel only', () => {
    const { emitter } = make();
    const zero = jest.fn();
    const one = jest.fn();
    emitter.on('ping', 0, zero);
    emitter.on('ping', 1, one);
    emitter.emit('ping', 0, 42);
    expect(zero).toHaveBeenCalledWith(42);
    expect(one).not.toHaveBeenCalled();
  });

  test('a listener without a channel receives every channel', () => {
    const { emitter } = make();
    const all = jest.fn();
    emitter.on('ping', undefined, all);
    emitter.emit('ping', 3, 1);
    emitter.emit('ping', 7, 2);
    expect(all).toHaveBeenCalledTimes(2);
  });

  test('the returned unsubscribe removes only that listener and is idempotent', () => {
    const { emitter } = make();
    const a = jest.fn();
    const b = jest.fn();
    const offA = emitter.on('ping', 0, a);
    emitter.on('ping', 0, b);
    offA();
    offA();
    emitter.emit('ping', 0, 1);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  test('off with a key removes only matching listeners', () => {
    const { emitter } = make();
    const a = jest.fn();
    const b = jest.fn();
    emitter.on('ping', 0, a);
    emitter.on('ping', 0, b);
    emitter.off('ping', 0, a);
    emitter.emit('ping', 0, 1);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  test('off matches a custom key when the callback was wrapped', () => {
    const { emitter } = make();
    const original = jest.fn<undefined, [number]>();
    emitter.on('ping', 0, (n) => original(n), original);
    emitter.off('ping', 0, original);
    emitter.emit('ping', 0, 1);
    expect(original).not.toHaveBeenCalled();
  });

  test('off without a key removes every listener of that event on that channel', () => {
    const { emitter } = make();
    const a = jest.fn();
    const other = jest.fn();
    emitter.on('ping', 0, a);
    emitter.on('ping', 1, other);
    emitter.off('ping', 0);
    emitter.off('pong', 0);
    emitter.emit('ping', 0, 1);
    emitter.emit('ping', 1, 1);
    expect(a).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalled();
  });

  test('clearChannel removes all events for one channel', () => {
    const { emitter } = make();
    const ping = jest.fn();
    const pong = jest.fn();
    const keep = jest.fn();
    emitter.on('ping', 2, ping);
    emitter.on('pong', 2, pong);
    emitter.on('pong', 3, keep);
    emitter.clearChannel(2);
    emitter.emit('ping', 2, 1);
    emitter.emit('pong', 2, 'x');
    emitter.emit('pong', 3, 'y');
    expect(ping).not.toHaveBeenCalled();
    expect(pong).not.toHaveBeenCalled();
    expect(keep).toHaveBeenCalledWith('y');
  });

  test('clear removes everything', () => {
    const { emitter } = make();
    const a = jest.fn();
    emitter.on('ping', undefined, a);
    emitter.clear();
    emitter.emit('ping', 0, 1);
    expect(a).not.toHaveBeenCalled();
  });

  test('has reports whether a matching listener exists', () => {
    const { emitter } = make();
    expect(emitter.has('ping', 0)).toBe(false);
    emitter.on('ping', 1, jest.fn());
    expect(emitter.has('ping', 0)).toBe(false);
    expect(emitter.has('ping', 1)).toBe(true);
    emitter.on('ping', undefined, jest.fn());
    expect(emitter.has('ping', 0)).toBe(true);
  });

  test('a throwing listener is reported and does not stop the others', () => {
    const { emitter, onError } = make();
    const after = jest.fn();
    const boom = new Error('boom');
    emitter.on('ping', 0, () => {
      throw boom;
    });
    emitter.on('ping', 0, after);
    emitter.emit('ping', 0, 1);
    expect(onError).toHaveBeenCalledWith(boom);
    expect(after).toHaveBeenCalled();
  });

  test('listeners added or removed during emit do not affect the current emit', () => {
    const { emitter } = make();
    const late = jest.fn();
    const second = jest.fn();
    let offSecond: () => void = () => undefined;
    emitter.on('ping', 0, () => {
      emitter.on('ping', 0, late);
      offSecond();
    });
    offSecond = emitter.on('ping', 0, second);
    emitter.emit('ping', 0, 1);
    expect(late).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
