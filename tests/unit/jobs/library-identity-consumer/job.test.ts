/**
 * Unit tests for jobs/library-identity-consumer/job.ts's span-attribute
 * projection (BS#1086).
 *
 * The run-totals span only surfaced `rows_skipped.lml_cardinality_mismatch`
 * as a `consumer.*` attribute — its sibling cardinality-class skip bucket,
 * `rows_skipped.lml_untrusted_library_id` (BS#1094, the result-validation
 * skip added to `orchestrate.ts`), was silently absent from every run's
 * trace, even though both buckets are populated the same way. `main()`
 * itself isn't unit-tested (mirrors the rest of the jobs/* fleet: the
 * `NODE_ENV !== 'test'` guard exists purely so this module can be imported
 * safely, per `jobs/album-level-backfill/job.ts`) — this file pins the
 * extracted, pure `buildSpanAttributes` mapping instead, so a future skip
 * bucket added to `Totals` without a matching span-attribute entry is
 * caught without needing to drive the whole job through Sentry/DB mocks.
 */
import { buildSpanAttributes } from '../../../../jobs/library-identity-consumer/job';
import type { Totals } from '../../../../jobs/library-identity-consumer/orchestrate';

const totals: Totals = {
  scanned: 500,
  rows_resolved: 300,
  rows_unresolved: 50,
  rows_skipped: {
    compilation: 40,
    lml_error: 20,
    writer_error: 5,
    lml_cardinality_mismatch: 3,
    lml_untrusted_library_id: 7,
  },
  source_rows_skipped_null_confidence: 2,
  lml_total_calls: 25,
  lml_total_latency_ms: 123456,
};

describe('buildSpanAttributes (BS#1086)', () => {
  it('surfaces rows_skipped.lml_untrusted_library_id as a span attribute, mirroring its lml_cardinality_mismatch sibling', () => {
    const attrs = buildSpanAttributes(totals);

    expect(attrs['consumer.rows_skipped.lml_cardinality_mismatch']).toBe(3);
    expect(attrs['consumer.rows_skipped.lml_untrusted_library_id']).toBe(7);
  });

  it('projects every Totals field onto its consumer.* span attribute', () => {
    const attrs = buildSpanAttributes(totals);

    expect(attrs).toEqual({
      'consumer.scanned': 500,
      'consumer.rows_resolved': 300,
      'consumer.rows_unresolved': 50,
      'consumer.rows_skipped.compilation': 40,
      'consumer.rows_skipped.lml_error': 20,
      'consumer.rows_skipped.writer_error': 5,
      'consumer.rows_skipped.lml_cardinality_mismatch': 3,
      'consumer.rows_skipped.lml_untrusted_library_id': 7,
      'consumer.source_rows_skipped_null_confidence': 2,
      'consumer.lml_total_calls': 25,
      'consumer.lml_total_latency_ms': 123456,
    });
  });

  it('emits every attribute as a number (Sentry indexes non-numeric values as strings, breaking avg/percentile aggregation)', () => {
    const attrs = buildSpanAttributes(totals);

    for (const value of Object.values(attrs)) {
      expect(typeof value).toBe('number');
    }
  });
});
