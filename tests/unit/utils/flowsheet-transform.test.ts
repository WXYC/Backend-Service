import { truncate } from '../../../apps/backend/utils/flowsheet-transform';

/**
 * BS#1090. `truncate()` is the live-write-path text normalizer the tubafrenzy
 * webhook receiver (apps/backend/routes/internal.route.ts) runs artist_name /
 * album_title / track_title / record_label / message through before writing
 * VARCHAR(128) / VARCHAR(250) columns. `String.prototype.slice` counts UTF-16
 * code units, not Unicode codepoints — a codepoint outside the Basic
 * Multilingual Plane (any 4-byte-UTF-8 character: emoji, many CJK Extension
 * B+ ideographs, etc.) is stored as a surrogate *pair* (two UTF-16 units). A
 * length-based slice can land between the high and low surrogate, splitting
 * the pair and producing an unpaired surrogate — invalid UTF-16 that
 * serializes to invalid UTF-8 (or a lossy U+FFFD) on the wire to Postgres.
 * A diacritic like "é" is NOT a reproduction of this bug: it's a single BMP
 * codepoint (2-byte UTF-8), one UTF-16 code unit — slicing around it can
 * split a combining-mark grapheme cluster, but never a surrogate pair.
 * The fix truncates on codepoint boundaries via `Array.from`/spread, which
 * iterates by Unicode codepoint (pairs surrogates back together).
 */
describe('truncate (BS#1090 — codepoint-boundary truncation)', () => {
  it('does not split a 4-byte / astral (surrogate-pair) character at the boundary', () => {
    // U+1F3B8 MUSICAL SYMBOL — surrogate pair D83C DFB8. "AB" + emoji is 3
    // codepoints but 4 UTF-16 code units, so a naive maxLength=3 code-unit
    // slice lands mid-pair and keeps only the high surrogate.
    const value = 'AB\u{1F3B8}';
    const result = truncate(value, 3);
    // The whole string is 3 codepoints, so nothing should be cut off, and
    // the emoji must survive intact (not split into a lone surrogate) — a
    // split pair would produce a distinct, corrupted string, so exact
    // equality with the untruncated input is sufficient proof the pair
    // wasn't torn apart.
    expect(result).toBe(value);
    expect([...result]).toHaveLength(3);
    // A lone (unpaired) surrogate is invalid UTF-16 and re-encodes as the
    // U+FFFD replacement character on the wire — assert it's absent.
    expect(result).not.toContain('�');
  });

  it('truncates a string that genuinely exceeds maxLength codepoints, counting astral chars as one codepoint each', () => {
    // 4 codepoints total (2 astral + 2 ASCII); maxLength=2 should keep
    // exactly the first 2 codepoints, astral chars intact.
    const value = '\u{1F3B8}\u{1F3B9}CD';
    const result = truncate(value, 2);
    expect(result).toBe('\u{1F3B8}\u{1F3B9}');
    expect([...result]).toHaveLength(2);
  });

  it('still truncates plain ASCII on a code-unit boundary as before', () => {
    expect(truncate('hello world', 5)).toBe('hello');
  });

  it('still trims and null-collapses as before', () => {
    expect(truncate('  padded  ', 20)).toBe('padded');
    expect(truncate('   ', 10)).toBeNull();
    expect(truncate(null, 10)).toBeNull();
    expect(truncate(undefined, 10)).toBeNull();
  });

  it('returns the original string unmodified when already within maxLength', () => {
    const value = 'short';
    expect(truncate(value, 100)).toBe(value);
  });
});
