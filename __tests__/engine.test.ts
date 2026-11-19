import { AudioQueue } from '../src/audio-queue';
import { QueueEngine } from '../src/engine';

describe('QueueEngine', () => {
  test('is the internal base class of AudioQueue', () => {
    const queue = new AudioQueue({ logger: null });
    expect(queue).toBeInstanceOf(QueueEngine);
  });

  test('validates configuration on construction', () => {
    expect(() => new QueueEngine({ prefetchCount: -1 })).toThrow(RangeError);
  });

  test('exposes no public methods of its own (everything public lives on AudioQueue)', () => {
    const own = Object.getOwnPropertyNames(QueueEngine.prototype).filter(
      (name) => name !== 'constructor'
    );
    const publicApi = Object.getOwnPropertyNames(AudioQueue.prototype);
    expect(own.some((name) => publicApi.includes(name))).toBe(false);
  });
});
