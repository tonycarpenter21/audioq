import {
  categorizeMediaError,
  categorizePlayError,
  isSameOriginSource,
  listen,
  releaseElement,
  resolveUrl,
  toError
} from '../src/media';
import { AudioErrorType } from '../src/types';
import { FakeAudio } from './helpers/fake-audio';

const named = (name: string): Error => {
  const error = new Error(name);
  error.name = name;
  return error;
};

describe('listen', () => {
  test('adds a listener and the disposer removes it', () => {
    const target = new EventTarget();
    const handler = jest.fn();
    const dispose = listen(target, 'ping', handler);
    target.dispatchEvent(new Event('ping'));
    dispose();
    target.dispatchEvent(new Event('ping'));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('resolveUrl', () => {
  test('resolves relative URLs against the document', () => {
    expect(resolveUrl('/a.mp3')).toBe(new URL('/a.mp3', document.baseURI).href);
  });

  test('keeps blob and data URLs intact', () => {
    expect(resolveUrl('blob:http://localhost/123')).toBe('blob:http://localhost/123');
    expect(resolveUrl('data:audio/wav;base64,AA')).toBe('data:audio/wav;base64,AA');
  });

  test('returns the input when it cannot be parsed', () => {
    expect(resolveUrl('http://[bad')).toBe('http://[bad');
  });
});

describe('releaseElement', () => {
  test('pauses, removes src and calls load to abort the fetch', () => {
    const audio = new FakeAudio('/a.mp3');
    audio.paused = false;
    releaseElement(audio as unknown as HTMLAudioElement);
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe('');
    expect(audio.loadCalls).toBe(1);
  });

  test('survives elements whose pause or load throw', () => {
    const audio = new FakeAudio('/a.mp3');
    audio.pause = (): void => {
      throw new Error('broken');
    };
    audio.load = (): void => {
      throw new Error('not implemented');
    };
    expect(() => releaseElement(audio as unknown as HTMLAudioElement)).not.toThrow();
    expect(audio.src).toBe('');
  });
});

describe('isSameOriginSource', () => {
  const origin = 'https://app.example.com';

  test.each([
    ['https://app.example.com/a.mp3', true],
    ['/relative.mp3', true],
    ['blob:https://app.example.com/uuid', true],
    ['data:audio/wav;base64,AA', true],
    ['https://cdn.other.com/a.mp3', false]
  ])('%s -> %p', (src, expected) => {
    expect(isSameOriginSource(src, origin)).toBe(expected);
  });

  test('is false without a page origin or for unparsable URLs', () => {
    expect(isSameOriginSource('https://a.com/x.mp3', undefined)).toBe(false);
    expect(isSameOriginSource('http://[bad', origin)).toBe(false);
  });
});

describe('categorizeMediaError', () => {
  test.each([
    [1, AudioErrorType.Abort],
    [2, AudioErrorType.Network],
    [3, AudioErrorType.Decode],
    [4, AudioErrorType.Unsupported],
    [99, AudioErrorType.Unknown]
  ])('code %p -> %p', (code, expected) => {
    expect(categorizeMediaError({ code })).toBe(expected);
  });

  test('null error is unknown', () => {
    expect(categorizeMediaError(null)).toBe(AudioErrorType.Unknown);
  });
});

describe('categorizePlayError', () => {
  test('AbortError is not a failure', () => {
    expect(categorizePlayError(named('AbortError'))).toBeNull();
  });

  test('NotAllowedError means autoplay was blocked', () => {
    expect(categorizePlayError(named('NotAllowedError'))).toBe(AudioErrorType.AutoplayBlocked);
  });

  test('NotSupportedError is unsupported', () => {
    expect(categorizePlayError(named('NotSupportedError'))).toBe(AudioErrorType.Unsupported);
  });

  test('works with DOMException-like objects that are not Errors', () => {
    expect(categorizePlayError({ name: 'NotAllowedError' })).toBe(AudioErrorType.AutoplayBlocked);
  });

  test('anything else is unknown', () => {
    expect(categorizePlayError(named('Other'))).toBe(AudioErrorType.Unknown);
    expect(categorizePlayError('string')).toBe(AudioErrorType.Unknown);
    expect(categorizePlayError(null)).toBe(AudioErrorType.Unknown);
  });
});

describe('toError', () => {
  test('returns Errors unchanged', () => {
    const error = new Error('x');
    expect(toError(error, 'fallback')).toBe(error);
  });

  test('converts named objects, keeping name and message', () => {
    const error = toError({ message: 'blocked', name: 'NotAllowedError' }, 'fallback');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NotAllowedError');
    expect(error.message).toBe('blocked');
  });

  test('named objects without a message use the fallback', () => {
    expect(toError({ name: 'X' }, 'fallback').message).toBe('fallback');
  });

  test('other values use the fallback message', () => {
    expect(toError(42, 'fallback').message).toBe('fallback');
  });
});
