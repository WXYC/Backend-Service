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
import { buildSpanAttributes, shouldAnalyzeCompilationTracks } from '../../../../jobs/library-identity-consumer/job';
import type { Totals } from '../../../../jobs/library-identity-consumer/orchestrate';

const totals: Totals = {
  scanned: 500,
  rows_resolved: 300,
  rows_resolved_compilation: 12,
  rows_unresolved: 50,
  rows_skipped: {
    compilation: 40,
    lml_error: 20,
    writer_error: 5,
    lml_cardinality_mismatch: 3,
    lml_untrusted_library_id: 7,
  },
  source_rows_skipped_null_confidence: 2,
  compilation_track_rows_written: 84,
  compilation_track_rows_skipped_unchanged: 9,
  compilation_track_rows_skipped_librarian: 6,
  compilation_track_rows_skipped_no_cta_match: 4,
  compilation_track_rows_skipped_no_catalog_artist: 11,
  compilation_track_position_rows_written: 13,
  compilation_track_position_rows_skipped_ambiguous: 2,
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
      'consumer.rows_resolved_compilation': 12,
      'consumer.rows_unresolved': 50,
      'consumer.rows_skipped.compilation': 40,
      'consumer.rows_skipped.lml_error': 20,
      'consumer.rows_skipped.writer_error': 5,
      'consumer.rows_skipped.lml_cardinality_mismatch': 3,
      'consumer.rows_skipped.lml_untrusted_library_id': 7,
      'consumer.source_rows_skipped_null_confidence': 2,
      'consumer.compilation_track_rows_written': 84,
      'consumer.compilation_track_rows_skipped_unchanged': 9,
      'consumer.compilation_track_rows_skipped_librarian': 6,
      'consumer.compilation_track_rows_skipped_no_cta_match': 4,
      'consumer.compilation_track_rows_skipped_no_catalog_artist': 11,
      'consumer.compilation_track_position_rows_written': 13,
      'consumer.compilation_track_position_rows_skipped_ambiguous': 2,
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

  it('BS#1991: namespaces attributes under a custom prefix so the va/non_va drains land as distinct span attributes', () => {
    const attrs = buildSpanAttributes(totals, 'consumer.va');

    expect(attrs['consumer.va.scanned']).toBe(500);
    expect(attrs['consumer.va.rows_resolved_compilation']).toBe(12);
    expect(attrs['consumer.va.compilation_track_rows_written']).toBe(84);
    expect(Object.keys(attrs).every((k) => k.startsWith('consumer.va.'))).toBe(true);
  });
});

describe('shouldAnalyzeCompilationTracks (BS#1991)', () => {
  // The bulk-update playbook pairs a bulk write with ANALYZE on the touched
  // table, once per run (not per page) — but only when something was
  // actually written: a dry-run makes no writes, and a no-op re-drain's
  // IS DISTINCT FROM guard can leave every drain at 0, where ANALYZE would
  // be wasted work on an unchanged table.
  it('is false on a dry run regardless of write counts', () => {
    expect(shouldAnalyzeCompilationTracks(true, 84, 12)).toBe(false);
  });

  it('is false when no drain wrote any compilation-track rows', () => {
    expect(shouldAnalyzeCompilationTracks(false, 0, 0)).toBe(false);
  });

  it('is true when any drain wrote at least one row', () => {
    expect(shouldAnalyzeCompilationTracks(false, 0, 1)).toBe(true);
    expect(shouldAnalyzeCompilationTracks(false, 84)).toBe(true);
  });
});
