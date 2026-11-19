/**
 * @fileoverview Tests for the per-queue storage of preloaded files.
 */
import { forgetMemory, memoryOf, peekMemory } from '../src/memory';

describe('memory', () => {
  test('is created on first use and kept per owner', () => {
    const owner = {};
    expect(peekMemory(owner)).toBeUndefined();
    const memory = memoryOf(owner);
    expect(memory.files.size).toBe(0);
    expect(memory.downloads.size).toBe(0);
    expect(memoryOf(owner)).toBe(memory);
    expect(peekMemory(owner)).toBe(memory);
    expect(peekMemory({})).toBeUndefined();
  });

  test('forgetMemory drops it; the next use starts empty', () => {
    const owner = {};
    memoryOf(owner).files.set('a', new Blob(['x']));
    forgetMemory(owner);
    expect(peekMemory(owner)).toBeUndefined();
    expect(memoryOf(owner).files.size).toBe(0);
  });
});
