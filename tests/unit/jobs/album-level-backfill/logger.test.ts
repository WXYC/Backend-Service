/**
 * Tests for the album-level-backfill observability logger's pure helpers.
 * The init / JSON-line behavior mirrors `jobs/flowsheet-metadata-backfill/logger.ts`
 * verbatim and is exercised by `tests/unit/jobs/flowsheet-etl/logger.test.ts`;
 * the duplicated resolveTracesSampleRate is re-asserted here so the
 * per-job duplication doesn't drift silently.
 */

import { resolveTracesSampleRate } from '../../../../jobs/album-level-backfill/logger';

describe('resolveTracesSampleRate', () => {
  it('defaults to 0 when env var is unset', () => {
    expect(resolveTracesSampleRate(undefined)).toBe(0);
  });

  it('parses valid values in [0, 1]', () => {
    expect(resolveTracesSampleRate('0')).toBe(0);
    expect(resolveTracesSampleRate('0.5')).toBe(0.5);
    expect(resolveTracesSampleRate('1')).toBe(1);
    expect(resolveTracesSampleRate('1.0')).toBe(1);
  });

  it('falls back to 0 on malformed or out-of-range values', () => {
    expect(resolveTracesSampleRate('abc')).toBe(0);
    expect(resolveTracesSampleRate('-0.5')).toBe(0);
    expect(resolveTracesSampleRate('1.5')).toBe(0);
    expect(resolveTracesSampleRate('NaN')).toBe(0);
    expect(resolveTracesSampleRate('Infinity')).toBe(0);
  });
});
