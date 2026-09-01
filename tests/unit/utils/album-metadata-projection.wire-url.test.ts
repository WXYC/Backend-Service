/**
 * Unit tests for `hasWireUrlParserDifferential`/`wireUrl` (BS#2339, collapsed
 * onto the shared `@wxyc/lml-client` scan by BS#2356).
 *
 * `hasWireUrlParserDifferential` now delegates to `@wxyc/lml-client`'s
 * exported `hasUrlParserDifferentialChar` — these tests pin that the
 * delegation is behavior-preserving: the same `<= 0x20 || 0x7f || 0x5c` bar,
 * plus `wireUrl`'s own trim-then-scan-then-parse contract on top of it.
 */
import { hasWireUrlParserDifferential, wireUrl } from '../../../apps/backend/utils/album-metadata-projection';

describe('hasWireUrlParserDifferential', () => {
  it.each([
    ['space', 'https://e.com/a b'],
    ['tab', 'https://e.com/a\tb'],
    ['newline', 'https://e.com/a\nb'],
    ['DEL (0x7f)', 'https://e.com/a\x7fb'],
    ['backslash-authority spoof', 'https://e.com\\@evil.example/x'],
  ])('is true for a string containing %s', (_label, value) => {
    expect(hasWireUrlParserDifferential(value)).toBe(true);
  });

  it.each([
    ['a well-formed URL', 'https://e.com/a/b?q=1'],
    [
      'a raw non-ASCII character (shipped verbatim, not part of this bar)',
      'https://en.wikipedia.org/wiki/Nilüfer_Yanya',
    ],
    ['the empty string', ''],
  ])('is false for %s', (_label, value) => {
    expect(hasWireUrlParserDifferential(value)).toBe(false);
  });
});

describe('wireUrl', () => {
  it('returns the trimmed original for a well-formed absolute http(s) URL', () => {
    expect(wireUrl('  https://open.spotify.com/album/abc  ')).toBe('https://open.spotify.com/album/abc');
  });

  it('preserves raw non-ASCII bytes verbatim (does not emit parsed.href)', () => {
    const url = 'https://en.wikipedia.org/wiki/Nilüfer_Yanya';
    expect(wireUrl(url)).toBe(url);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['relative path', '/album/doga'],
    ['scheme-relative', '//open.spotify.com/album/abc'],
    ['non-web scheme', 'javascript:alert(1)'],
    ['a raw tab (parser differential)', 'https://e.com/a\tb'],
    ['a raw backslash (parser differential)', 'https://e.com\\@evil.example/x'],
  ])('returns undefined for %s', (_label, value) => {
    expect(wireUrl(value)).toBeUndefined();
  });
});
