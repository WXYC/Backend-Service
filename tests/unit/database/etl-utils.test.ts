import { epochMsToDate, truncate, parseTabRow, toNullable } from '@wxyc/database';
// jest.unit.config.ts maps the `@wxyc/database` specifier to
// tests/mocks/database.mock.ts for every unit test, so the `truncate` above
// exercises that mock's copy, not the real `shared/database/src/legacy/etl-utils.ts`
// implementation. Import the real module directly (bypassing the
// moduleNameMapper) to pin the actual production behavior the tubafrenzy
// webhook receiver (apps/backend/routes/internal.route.ts, live write path)
// and the flowsheet/rotation ETL jobs depend on at runtime (BS#1090).
// etl-utils.ts also imports the real `db` client at module scope (for
// getLastRunTimestamp/updateLastRun, unrelated to truncate), which throws on
// missing DB env vars outside integration tests — mock `client.js` the same
// way tests/unit/database/concerts-recompute.test.ts does for its own
// direct-module import.
jest.mock('../../../shared/database/src/client.js', () => jest.requireActual('../../mocks/database.mock'), {
  virtual: true,
});
import { truncate as truncateReal } from '../../../shared/database/src/legacy/etl-utils';

describe('epochMsToDate', () => {
  it('converts valid epoch ms to Date', () => {
    const date = epochMsToDate(1706788800000);
    expect(date).toBeInstanceOf(Date);
    expect(date?.toISOString()).toBe('2024-02-01T12:00:00.000Z');
  });

  it('returns null for 0', () => {
    expect(epochMsToDate(0)).toBeNull();
  });

  it('returns null for null', () => {
    expect(epochMsToDate(null)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(epochMsToDate(NaN)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(epochMsToDate(Infinity)).toBeNull();
  });
});

describe('truncate', () => {
  it('returns string unchanged when within limit', () => {
    expect(truncate('hello', 128)).toBe('hello');
  });

  it('truncates string exceeding limit', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcde');
  });

  it('trims whitespace', () => {
    expect(truncate('  hello  ', 128)).toBe('hello');
  });

  it('returns null for null input', () => {
    expect(truncate(null, 128)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(truncate(undefined, 128)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(truncate('', 128)).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(truncate('   ', 128)).toBeNull();
  });
});

/**
 * BS#1090. `truncate` is the live-write-path text normalizer the tubafrenzy
 * webhook receiver (apps/backend/routes/internal.route.ts) runs
 * artist_name/album_title/track_title/record_label/message through before
 * writing VARCHAR(128)/VARCHAR(250) columns — imported there straight from
 * `@wxyc/database`, i.e. this exact function. It's also re-exported
 * verbatim by jobs/flowsheet-etl/transform.ts for the ETL write path.
 *
 * `String.prototype.slice` counts UTF-16 code units, not Unicode
 * codepoints. A codepoint outside the Basic Multilingual Plane (any
 * 4-byte-UTF-8 character: emoji, many CJK Extension B+ ideographs) is
 * stored as a surrogate *pair* — two UTF-16 code units. A length-based
 * slice can land between the high and low surrogate, splitting the pair
 * into invalid UTF-16 that serializes to invalid/lossy (U+FFFD) UTF-8 on
 * the wire to Postgres, whose varchar(n) counts codepoints, not UTF-16
 * units. A diacritic like "é" does NOT reproduce this bug — it's a single
 * BMP codepoint (2-byte UTF-8, one UTF-16 code unit); this uses a genuine
 * astral character (U+1F3B8, guitar emoji — a real surrogate pair)
 * instead. Imported directly from the source module (not `@wxyc/database`)
 * so this test exercises the actual production implementation rather than
 * `tests/mocks/database.mock.ts`'s copy.
 */
describe('truncate (real implementation — BS#1090 codepoint-boundary truncation)', () => {
  it('does not split a 4-byte / astral (surrogate-pair) character at the boundary', () => {
    const value = 'AB\u{1F3B8}';
    const result = truncateReal(value, 3);
    // The whole string is 3 codepoints, so nothing should be cut off, and
    // the emoji must survive intact — a torn surrogate pair would produce a
    // distinct (and invalid) string, so exact equality is proof enough.
    expect(result).toBe(value);
    expect(result).not.toContain('�');
  });

  it('truncates a string exceeding maxLength codepoints, counting an astral character as one codepoint', () => {
    // 4 codepoints total (2 astral + 2 ASCII); maxLength=2 keeps exactly
    // the first 2 codepoints, astral characters intact.
    const value = '\u{1F3B8}\u{1F3B9}CD';
    expect(truncateReal(value, 2)).toBe('\u{1F3B8}\u{1F3B9}');
  });

  it('still truncates plain ASCII on a codepoint boundary as before', () => {
    expect(truncateReal('abcdefghij', 5)).toBe('abcde');
  });

  it('still trims and null-collapses as before', () => {
    expect(truncateReal('  hello  ', 128)).toBe('hello');
    expect(truncateReal('   ', 128)).toBeNull();
    expect(truncateReal(null, 128)).toBeNull();
    expect(truncateReal(undefined, 128)).toBeNull();
  });
});

describe('parseTabRow', () => {
  it('splits tab-separated values when column count matches', () => {
    expect(parseTabRow('a\tb\tc', 3)).toEqual(['a', 'b', 'c']);
  });

  it('returns null when column count does not match', () => {
    expect(parseTabRow('a\tb', 3)).toBeNull();
  });

  it('handles empty columns', () => {
    expect(parseTabRow('\t\t', 3)).toEqual(['', '', '']);
  });
});

describe('toNullable', () => {
  it('returns trimmed value for non-empty string', () => {
    expect(toNullable('hello')).toBe('hello');
  });

  it('trims whitespace', () => {
    expect(toNullable('  hello  ')).toBe('hello');
  });

  it('returns null for empty string', () => {
    expect(toNullable('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(toNullable('   ')).toBeNull();
  });

  it('returns null for "NULL" string', () => {
    expect(toNullable('NULL')).toBeNull();
  });
});
