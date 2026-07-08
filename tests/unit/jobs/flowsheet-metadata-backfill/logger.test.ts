/**
 * Tests for the flowsheet-metadata-backfill observability logger's pure
 * helpers. The init / JSON-line behavior mirrors `jobs/flowsheet-etl/logger.ts`
 * verbatim and is exercised by that job's smoke tests.
 *
 * This job intentionally diverges from the sibling ETL crons (BS#1563): an
 * unset `SENTRY_TRACES_SAMPLE_RATE` defaults to 1.0 (not 0), because the
 * `flowsheet-metadata-backfill.run.totals` span — carrying the `enrich_error`
 * corruption tell (#1561) — is this job's alerting substrate. Defaulting
 * tracing off makes any span-based alert dead-on-arrival (the #1560 wedge went
 * unnoticed for ~2.5 weeks). Mirrors the rotation-artist-backfill divergence
 * pinned in PR #1459. These tests pin the divergence so a future "align with
 * siblings" refactor can't silently re-disable the job's observability.
 */

import { resolveTracesSampleRate } from '../../../../jobs/flowsheet-metadata-backfill/logger';

describe('resolveTracesSampleRate (flowsheet-metadata-backfill)', () => {
  it('defaults to 1.0 when env var is unset (diverges from sibling crons on purpose)', () => {
    expect(resolveTracesSampleRate(undefined)).toBe(1);
  });

  it('parses valid values in [0, 1] — explicit downshift lever preserved', () => {
    expect(resolveTracesSampleRate('0')).toBe(0);
    expect(resolveTracesSampleRate('0.5')).toBe(0.5);
    expect(resolveTracesSampleRate('1')).toBe(1);
    expect(resolveTracesSampleRate('1.0')).toBe(1);
  });

  it('falls back to the 1.0 default on malformed or out-of-range values (a typo must not disable observability)', () => {
    expect(resolveTracesSampleRate('abc')).toBe(1);
    expect(resolveTracesSampleRate('-0.5')).toBe(1);
    expect(resolveTracesSampleRate('1.5')).toBe(1);
    expect(resolveTracesSampleRate('NaN')).toBe(1);
    expect(resolveTracesSampleRate('Infinity')).toBe(1);
  });
});
