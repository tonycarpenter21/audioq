import { parseVttTimestamp, parseWebVtt } from '../src/webvtt';

describe('parseVttTimestamp', () => {
  test.each([
    ['00:01.500', 1500],
    ['01:02.003', 62003],
    ['1:00:00.000', 3600000],
    ['00:00:05,25', 5250],
    ['00:07.5', 7500],
    ['00:07', 7000]
  ])('%s is %p ms', (timestamp, expected) => {
    expect(parseVttTimestamp(timestamp)).toBe(expected);
  });
});

describe('parseWebVtt', () => {
  test('parses captions with ids, multiple lines, settings and CRLF line endings', () => {
    const vtt = [
      'WEBVTT - Intro',
      '',
      'NOTE this is a comment',
      'spanning lines',
      '',
      'STYLE',
      '::cue { color: yellow }',
      '',
      'greeting',
      '00:00.000 --> 00:02.400 align:start',
      'Welcome back!',
      '',
      '00:02.600 --> 00:00:05.000',
      'Two lines',
      'of text',
      ''
    ].join('\r\n');
    expect(parseWebVtt(vtt)).toEqual([
      { data: 'greeting', endMs: 2400, startMs: 0, text: 'Welcome back!' },
      { endMs: 5000, startMs: 2600, text: 'Two lines\nof text' }
    ]);
  });

  test('skips blocks without a valid timing line or with end before start', () => {
    const vtt = 'WEBVTT\n\nno timing here\n\n00:05.000 --> 00:04.000\nbackwards\n\nREGION\nid:x';
    expect(parseWebVtt(vtt)).toEqual([]);
  });

  test('returns nothing for an empty file', () => {
    expect(parseWebVtt('')).toEqual([]);
  });
});
