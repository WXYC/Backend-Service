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
 *
 * BS#1566: because `tracesSampleRate` is global to the SDK, defaulting it to
 * 1.0 also sampled every per-row `lml.lookup` / `http.client` transaction the
 * drain opens (≤~1,200/hour) — a flood that was zero before #1564. The job now
 * installs a `tracesSampler` that keeps ONLY the totals span at 1.0 and drops
 * the bulk per-row spans to `NON_TOTALS_SAMPLE_RATE`. These tests pin that
 * scoping so the totals span can't become probabilistic and the per-row flood
 * can't return.
 */

import {
  resolveTracesSampleRate,
  tracesSampler,
  TOTALS_SPAN_OP,
  TOTALS_SPAN_NAME,
  NON_TOTALS_SAMPLE_RATE,
} from '../../../../jobs/flowsheet-metadata-backfill/logger';

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

describe('tracesSampler (flowsheet-metadata-backfill) — BS#1566 sampling scope', () => {
  // The SDK folds the `op` passed to `startSpan` into the sampling context's
  // `attributes` as `sentry.op` (verified against @sentry/node@10), and also
  // passes the span `name`. These fixtures mirror the two spans the drain emits.
  const totalsCtx = { name: TOTALS_SPAN_NAME, attributes: { 'sentry.op': TOTALS_SPAN_OP } };
  const lmlLookupCtx = { name: 'lml.lookup', attributes: { 'sentry.op': 'http.client' } };

  it('keeps the totals span at 1.0 by its op (the alerting substrate must stay deterministic)', () => {
    expect(tracesSampler(totalsCtx, 1)).toBe(1);
  });

  it('keeps the totals span at 1.0 even when the resolved env rate is a low non-zero value', () => {
    // Decoupling: dialing the env rate down to tame bulk volume must not make
    // the totals span probabilistic.
    expect(tracesSampler(totalsCtx, 0.01)).toBe(1);
  });

  it('matches the totals span by name too, as a fallback when the op attribute is absent', () => {
    expect(tracesSampler({ name: TOTALS_SPAN_NAME }, 1)).toBe(1);
  });

  it('drops per-row lml.lookup / http.client spans to NON_TOTALS_SAMPLE_RATE (no per-lookup flood)', () => {
    expect(tracesSampler(lmlLookupCtx, 1)).toBe(NON_TOTALS_SAMPLE_RATE);
    // The whole point of #1566: the bulk per-row spans are silenced by default.
    expect(NON_TOTALS_SAMPLE_RATE).toBe(0);
  });

  it('drops any other unlabeled span to NON_TOTALS_SAMPLE_RATE', () => {
    expect(tracesSampler({ name: 'something.else', attributes: { 'sentry.op': 'db.query' } }, 1)).toBe(
      NON_TOTALS_SAMPLE_RATE
    );
    expect(tracesSampler({}, 1)).toBe(NON_TOTALS_SAMPLE_RATE);
  });

  it('kill switch: an explicit SENTRY_TRACES_SAMPLE_RATE=0 silences EVERY span, totals included', () => {
    expect(tracesSampler(totalsCtx, 0)).toBe(0);
    expect(tracesSampler(lmlLookupCtx, 0)).toBe(0);
  });

  it('defaults its env rate from resolveTracesSampleRate() (unset env → 1.0 → totals kept, bulk dropped)', () => {
    const prev = process.env.SENTRY_TRACES_SAMPLE_RATE;
    delete process.env.SENTRY_TRACES_SAMPLE_RATE;
    try {
      expect(tracesSampler(totalsCtx)).toBe(1);
      expect(tracesSampler(lmlLookupCtx)).toBe(NON_TOTALS_SAMPLE_RATE);
    } finally {
      if (prev === undefined) delete process.env.SENTRY_TRACES_SAMPLE_RATE;
      else process.env.SENTRY_TRACES_SAMPLE_RATE = prev;
    }
  });

  it('kill switch via env default: SENTRY_TRACES_SAMPLE_RATE=0 silences the totals span too', () => {
    const prev = process.env.SENTRY_TRACES_SAMPLE_RATE;
    process.env.SENTRY_TRACES_SAMPLE_RATE = '0';
    try {
      expect(tracesSampler(totalsCtx)).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.SENTRY_TRACES_SAMPLE_RATE;
      else process.env.SENTRY_TRACES_SAMPLE_RATE = prev;
    }
  });
});
