/**
 * @fileoverview WebVTT caption files to cues. A standalone helper, so apps that do not use it do
 * not ship it.
 */

import type { AudioCue } from './types.js';

const TIMING =
  /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

/**
 * Converts a WebVTT timestamp (`mm:ss.ttt` or `hh:mm:ss.ttt`) to milliseconds.
 * @param timestamp - Timestamp text
 * @returns Milliseconds
 */
export const parseVttTimestamp = (timestamp: string): number => {
  const [clock = '', fraction = '0'] = timestamp.replace(',', '.').split('.');
  const parts = clock.split(':').map(Number);
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds * 1000 + Number(fraction.padEnd(3, '0').slice(0, 3));
};

/**
 * Parses a WebVTT caption file into cues for the `cues` option. Each caption becomes a ranged cue
 * with its text (lines joined with a newline) and, when the caption has an identifier, that
 * identifier as `data`. NOTE, STYLE and REGION blocks and cue settings are ignored.
 * @param text - Contents of a .vtt file
 * @returns Cues in file order
 * @example
 * ```typescript
 * const vtt = await (await fetch('/captions/intro.vtt')).text();
 * await queueAudio('/voice/intro.mp3', 1, { cues: parseWebVtt(vtt) });
 * ```
 */
export const parseWebVtt = (text: string): AudioCue[] => {
  const cues: AudioCue[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    if (/^(NOTE|STYLE|REGION)\b/.test(block)) continue;
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => TIMING.test(line));
    const [, start, end] = TIMING.exec(lines[timingIndex] ?? '') ?? [];
    if (start === undefined || end === undefined) continue;
    const startMs = parseVttTimestamp(start);
    const endMs = parseVttTimestamp(end);
    if (!(endMs > startMs)) continue;
    const text = lines
      .slice(timingIndex + 1)
      .filter((line) => line.length > 0)
      .join('\n');
    const cue: AudioCue = { endMs, startMs, text };
    if (timingIndex > 0) cue.data = lines[timingIndex - 1];
    cues.push(cue);
  }
  return cues;
};
