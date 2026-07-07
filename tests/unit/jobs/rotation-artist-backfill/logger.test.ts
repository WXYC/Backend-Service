/**
 * Tests for the rotation-artist-backfill logger's pure helpers.
 *
 * This job intentionally diverges from the sibling ETL crons: an unset
 * `SENTRY_TRACES_SAMPLE_RATE` defaults to 1.0 (not 0), because the
 * `rotation-artist-backfill.run.totals` span is the data source for the
 * BS#1402 alert rules and the BS#1428 numeric-typing verification. Defaulting
 * tracing off made those alerts dead-on-arrival (BS#1428: zero job spans in 30
 * days). These tests pin the divergence so a future "align with siblings"
 * refactor can't silently re-disable the job's observability.
 */

import { resolveTracesSampleRate } from '../../../../jobs/rotation-artist-backfill/logger';

describe('resolveTracesSampleRate (rotation-artist-backfill)', () => {
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
