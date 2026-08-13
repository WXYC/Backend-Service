import {
  epochMsToDate,
  truncate,
  parseTabRow,
  toNullable,
  FUTURE_TIMESTAMP_TOLERANCE_MS as FUTURE_TIMESTAMP_TOLERANCE_MS_MOCK,
  isBeyondFutureTolerance as isBeyondFutureToleranceMock,
} from '@wxyc/database';
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
import {
  truncate as truncateReal,
  isBeyondFutureTolerance as isBeyondFutureToleranceReal,
  FUTURE_TIMESTAMP_TOLERANCE_MS as FUTURE_TIMESTAMP_TOLERANCE_MS_REAL,
} from '../../../shared/database/src/legacy/etl-utils';

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

  // BS#2143: pins the guard that keeps `radio_hour` correct. A breakpoint's
  // `radio_hour` is legitimately up to ~a minute in the future (BS#1449), so
  // `epochMsToDate` — the converter `radio_hour` goes through — must NEVER
  // clamp a future date. The future-tolerance bound lives in the separate
  // `isBeyondFutureTolerance` predicate instead; this test fails if someone
  // "simplifies" by folding that clamp into this converter.
  it('returns a far-future date unchanged (no future clamp in the converter itself)', () => {
    const farFutureMs = Date.now() + 365 * 24 * 60 * 60 * 1000; // ~1 year ahead
    const date = epochMsToDate(farFutureMs);
    expect(date).toBeInstanceOf(Date);
    expect(date?.getTime()).toBe(farFutureMs);
  });
});

/**
 * BS#2143. `isBeyondFutureTolerance` is the shared predicate bounding
 * `flowsheet.add_time` at write time (the webhook's `markerTimestamp` in
 * apps/backend/routes/internal.route.ts and `resolveEntryTimestamp` in
 * jobs/flowsheet-etl/transform.ts). Imported from the real module (not the
 * `@wxyc/database` top-of-file import, which resolves to
 * tests/mocks/database.mock.ts's hand-maintained copy) so this test pins the
 * actual production implementation, mirroring the `truncate`/`truncateReal`
 * split above.
 */
describe('isBeyondFutureTolerance (real implementation)', () => {
  const now = new Date('2026-08-13T18:00:00.000Z');

  it('is false for a date exactly at the tolerance boundary', () => {
    const atBoundary = new Date(now.getTime() + FUTURE_TIMESTAMP_TOLERANCE_MS_REAL);
    expect(isBeyondFutureToleranceReal(atBoundary, now)).toBe(false);
  });

  it('is false for a date 1ms inside the tolerance boundary', () => {
    const justInside = new Date(now.getTime() + FUTURE_TIMESTAMP_TOLERANCE_MS_REAL - 1);
    expect(isBeyondFutureToleranceReal(justInside, now)).toBe(false);
  });

  it('is true for a date 1ms beyond the tolerance boundary', () => {
    const justOutside = new Date(now.getTime() + FUTURE_TIMESTAMP_TOLERANCE_MS_REAL + 1);
    expect(isBeyondFutureToleranceReal(justOutside, now)).toBe(true);
  });

  it('is false for a date in the past', () => {
    const past = new Date(now.getTime() - 1000);
    expect(isBeyondFutureToleranceReal(past, now)).toBe(false);
  });

  it('is false for a date equal to now', () => {
    expect(isBeyondFutureToleranceReal(new Date(now.getTime()), now)).toBe(false);
  });

  it('is false for null', () => {
    expect(isBeyondFutureToleranceReal(null, now)).toBe(false);
  });

  it('defaults `now` to the wall clock when not injected', () => {
    // Deterministic without fake timers: a date far enough in the past can
    // never be "beyond" whatever `now` actually resolves to.
    const wayInThePast = new Date('2000-01-01T00:00:00.000Z');
    expect(isBeyondFutureToleranceReal(wayInThePast)).toBe(false);
  });

  // tests/mocks/database.mock.ts hand-copies both symbols (it can't import
  // the real module: etl-utils.ts imports the `db` client at module scope,
  // which is the very thing the mock exists to stand in for, so a re-export
  // would be circular). This file is the one place that holds BOTH copies, so
  // it's the only place that can pin them together.
  //
  // Without this, a hand-copy is free to drift, and the drift is invisible:
  // the consumer tests that actually exercise the bound
  // (tests/unit/routes/internal.route.test.ts,
  // tests/unit/jobs/flowsheet-etl/transform.test.ts) resolve `@wxyc/database`
  // to the mock, so they'd keep asserting against the STALE tolerance and stay
  // green while production clamped at a different threshold. Tighten the real
  // constant to 30s without touching the mock and this test — not those —
  // is what fails.
  describe('mock parity (tests/mocks/database.mock.ts must not drift)', () => {
    it('mirrors FUTURE_TIMESTAMP_TOLERANCE_MS exactly', () => {
      expect(FUTURE_TIMESTAMP_TOLERANCE_MS_MOCK).toBe(FUTURE_TIMESTAMP_TOLERANCE_MS_REAL);
    });

    it.each([
      ['1ms inside the boundary', FUTURE_TIMESTAMP_TOLERANCE_MS_REAL - 1],
      ['exactly at the boundary', FUTURE_TIMESTAMP_TOLERANCE_MS_REAL],
      ['1ms beyond the boundary', FUTURE_TIMESTAMP_TOLERANCE_MS_REAL + 1],
      ['far in the future', 60 * 60 * 1000],
      ['in the past', -1000],
    ])('agrees with the real predicate for a date %s', (_label, offsetMs) => {
      const date = new Date(now.getTime() + offsetMs);
      expect(isBeyondFutureToleranceMock(date, now)).toBe(isBeyondFutureToleranceReal(date, now));
    });

    it('agrees with the real predicate for null', () => {
      expect(isBeyondFutureToleranceMock(null, now)).toBe(isBeyondFutureToleranceReal(null, now));
    });
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

  it('does not tear the surrogate pair when the cut falls right after an astral character', () => {
    // 3 codepoints (A, astral guitar, B); maxLength=2 keeps 'A' + the intact
    // emoji. The old `String.prototype.slice(0, 2)` code-unit slice would
    // instead cut mid-surrogate-pair, yielding the torn 'A\uD83C'.
    expect(truncateReal('A\u{1F3B8}B', 2)).toBe('A\u{1F3B8}');
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
