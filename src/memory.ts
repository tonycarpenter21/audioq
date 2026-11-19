/**
 * @fileoverview Per-queue storage for preloaded files. Kept apart from preload.ts so the engine
 * can look files up without bundling the download code.
 */

import type { PreloadResult } from './types.js';

/** A queue's preloaded files and running downloads, by resolved URL. */
export interface Memory {
  downloads: Map<string, Promise<PreloadResult>>;
  files: Map<string, Blob>;
}

const memories: WeakMap<object, Memory> = new WeakMap();

/**
 * A queue's storage, created on first use.
 * @param owner - The queue
 * @returns Its storage
 */
export const memoryOf = (owner: object): Memory => {
  let memory = memories.get(owner);
  if (!memory) {
    memory = { downloads: new Map(), files: new Map() };
    memories.set(owner, memory);
  }
  return memory;
};

/**
 * A queue's storage, if it has any.
 * @param owner - The queue
 * @returns Its storage, or undefined when nothing was preloaded
 */
export const peekMemory = (owner: object): Memory | undefined => memories.get(owner);

/**
 * Drops a queue's storage: files are freed and running downloads are not kept.
 * @param owner - The queue
 */
export const forgetMemory = (owner: object): void => {
  memories.delete(owner);
};
