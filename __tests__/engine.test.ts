import { createAudioQueue } from '../src/queue';
import { QueueEngine } from '../src/engine';

describe('QueueEngine', () => {
  test('is the object behind every queue (typed opaquely as AudioQueue)', () => {
    expect(createAudioQueue({ logger: null })).toBeInstanceOf(QueueEngine);
  });

  test('validates configuration on construction', () => {
    expect(() => new QueueEngine({ prefetchCount: -1 })).toThrow(RangeError);
  });
});
