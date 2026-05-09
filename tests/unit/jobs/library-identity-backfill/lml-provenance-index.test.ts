/**
 * Unit tests for the LML provenance index — the in-memory `Map<(library_name,
 * source), {method, confidence}>` built at job start from
 * `entity.identity ⨝ entity.reconciliation_log` (sub-PR 2.1).
 *
 * The reader's two responsibilities:
 *   1. Bulk-fetch the latest reconciliation_log entry per (identity_id,
 *      source) tuple via `DISTINCT ON (...) ORDER BY created_at DESC`.
 *   2. Build a normalized Map keyed by `(library_name, source)` so the S2
 *      resolver can look up provenance in O(1).
 *
 * The query itself is exercised against a real PG in the integration tests;
 * unit tests cover the pure index-building from input rows.
 */
import {
  buildProvenanceIndex,
  type ProvenanceRow,
} from '../../../../jobs/library-identity-backfill/sources/lml-provenance-index';

const row = (overrides: Partial<ProvenanceRow>): ProvenanceRow => ({
  library_name: 'Stereolab',
  source: 'discogs',
  method: 'exact_match',
  confidence: 1.0,
  ...overrides,
});

describe('buildProvenanceIndex', () => {
  it('returns an empty index when no rows are passed', () => {
    const index = buildProvenanceIndex([]);
    expect(index.size).toBe(0);
    expect(index.lookup('Stereolab', 'discogs')).toBeUndefined();
  });

  it('keys lookups by (library_name, source)', () => {
    const rows: ProvenanceRow[] = [
      row({ library_name: 'Stereolab', source: 'discogs', method: 'exact_match', confidence: 1.0 }),
      row({ library_name: 'Stereolab', source: 'wikidata', method: 'name_variation', confidence: 0.95 }),
      row({ library_name: 'Autechre', source: 'discogs', method: 'alias_match', confidence: 0.85 }),
    ];

    const index = buildProvenanceIndex(rows);

    expect(index.lookup('Stereolab', 'discogs')).toEqual({ method: 'exact_match', confidence: 1.0 });
    expect(index.lookup('Stereolab', 'wikidata')).toEqual({ method: 'name_variation', confidence: 0.95 });
    expect(index.lookup('Autechre', 'discogs')).toEqual({ method: 'alias_match', confidence: 0.85 });
  });

  it('returns undefined for unknown (library_name, source) pairs', () => {
    const index = buildProvenanceIndex([row({ library_name: 'Stereolab', source: 'discogs' })]);
    expect(index.lookup('Stereolab', 'spotify')).toBeUndefined();
    expect(index.lookup('Unknown Artist', 'discogs')).toBeUndefined();
  });

  it('treats lookups as exact matches (no normalization or case-folding)', () => {
    // Backend.artists.artist_name is the canonical key; LML's library_name is
    // expected to match byte-for-byte after the artist-identity-etl run. If
    // they drift, that's an ETL bug, not a backfill bug — surface as a miss
    // rather than smuggling in a normalization step that papers over drift.
    const index = buildProvenanceIndex([row({ library_name: 'Stereolab', source: 'discogs' })]);
    expect(index.lookup('stereolab', 'discogs')).toBeUndefined();
    expect(index.lookup('STEREOLAB', 'discogs')).toBeUndefined();
  });

  it('handles confidence=null (older reconciliation_log rows had nullable confidence)', () => {
    // Per LML's schema (`scripts/entity_resolution/store.py:201-225`),
    // confidence is `REAL` and can be NULL. Surface the null verbatim — the
    // resolver decides whether to fall back to the per-row default.
    const rows: ProvenanceRow[] = [
      row({ library_name: 'Cat Power', source: 'discogs', method: 'manual', confidence: null }),
    ];

    const index = buildProvenanceIndex(rows);

    expect(index.lookup('Cat Power', 'discogs')).toEqual({ method: 'manual', confidence: null });
  });

  it('reports the size of the index for log/observability', () => {
    const rows: ProvenanceRow[] = [
      row({ library_name: 'A', source: 'discogs' }),
      row({ library_name: 'B', source: 'wikidata' }),
      row({ library_name: 'C', source: 'mb' }),
    ];

    const index = buildProvenanceIndex(rows);

    expect(index.size).toBe(3);
  });
});
