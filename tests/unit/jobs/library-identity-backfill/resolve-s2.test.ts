/**
 * Unit tests for the S2 resolver — Backend's mirrored `artists` identity
 * columns → per-source rows for the library-identity-backfill (sub-PR 2.1).
 *
 * Inputs:
 *   - One library row joined to its `artists` row (6 identity columns).
 *   - The provenance index built from LML's `entity.reconciliation_log`.
 *
 * Output: one ResolveOutcome — match (with up to 6 SourceRowToWrite),
 * no_identity_columns (when every identity column is null), or
 * artist_name_missing (defensive; library.artist_id is non-null but the
 * artists row has no name).
 *
 * Key behaviors covered:
 *   - One per-source row per non-null identity column.
 *   - `(method, confidence)` looked up from provenance index when
 *     present.
 *   - Narrow fallback (`alias_match 0.85`) when the index has no entry
 *     for that (library_name, source) pair.
 *   - `agreementSources` populated when ≥2 identity columns are non-null.
 */
import { resolveS2, type LibraryArtistRow } from '../../../../jobs/library-identity-backfill/resolve-s2';
import type { ProvenanceIndex } from '../../../../jobs/library-identity-backfill/sources/lml-provenance-index';

const buildIndex = (
  entries: Array<[string, string, { method: string; confidence: number | null }]>
): ProvenanceIndex => {
  const map = new Map<string, { method: string; confidence: number | null }>();
  for (const [name, source, value] of entries) map.set(`${name} ${source}`, value);
  return {
    lookup: (libraryName, source) => map.get(`${libraryName} ${source}`),
    size: map.size,
  };
};

const baseRow = (overrides: Partial<LibraryArtistRow>): LibraryArtistRow => ({
  id: 100,
  artist_name: 'Stereolab',
  discogs_artist_id: null,
  musicbrainz_artist_id: null,
  wikidata_qid: null,
  spotify_artist_id: null,
  apple_music_artist_id: null,
  bandcamp_id: null,
  last_modified: new Date('2026-04-15T00:00:00Z'),
  ...overrides,
});

describe('resolveS2', () => {
  it('reports no_identity_columns when every identity column is null', () => {
    const row = baseRow({ id: 100 });
    const outcome = resolveS2(row, buildIndex([]));
    expect(outcome.status).toBe('no_identity_columns');
  });

  it('reports artist_name_missing defensively when artist_name is null', () => {
    // After Epic A.2's library_artist_name backfill, library_id rows have
    // an artist_name; if a future hand-edit somehow nulls it, surface as a
    // skip rather than smuggling an empty key into the provenance lookup.
    const row = { ...baseRow({ id: 100, discogs_artist_id: 12345 }), artist_name: null as unknown as string };
    const outcome = resolveS2(row, buildIndex([]));
    expect(outcome.status).toBe('artist_name_missing');
  });

  it('produces one per-source row per non-null identity column', () => {
    const row = baseRow({
      id: 100,
      artist_name: 'Stereolab',
      discogs_artist_id: 12345,
      wikidata_qid: 'Q483507',
      musicbrainz_artist_id: 'aaaa-bbbb-cccc',
    });
    const index = buildIndex([
      ['Stereolab', 'discogs', { method: 'exact_match', confidence: 1.0 }],
      ['Stereolab', 'wikidata', { method: 'name_variation', confidence: 0.95 }],
      ['Stereolab', 'musicbrainz', { method: 'alias_match', confidence: 0.85 }],
    ]);

    const outcome = resolveS2(row, index);

    expect(outcome.status).toBe('match');
    if (outcome.status !== 'match') return;
    expect(outcome.sourceRows).toHaveLength(3);
    const sources = outcome.sourceRows.map((r) => r.source).sort();
    expect(sources).toEqual(['discogs_artist', 'mb_artist', 'wikidata']);
  });

  it('uses real (method, confidence) from the provenance index when found', () => {
    const row = baseRow({ id: 100, artist_name: 'Stereolab', discogs_artist_id: 12345 });
    const index = buildIndex([['Stereolab', 'discogs', { method: 'exact_match', confidence: 1.0 }]]);

    const outcome = resolveS2(row, index);

    if (outcome.status !== 'match') throw new Error('expected match');
    expect(outcome.sourceRows).toHaveLength(1);
    expect(outcome.sourceRows[0]).toMatchObject({
      library_id: 100,
      source: 'discogs_artist',
      external_id: '12345',
      method: 'exact_match',
      confidence: 1.0,
      notes: 'backfill:S2',
    });
  });

  it('falls back to alias_match 0.85 when the provenance index has no entry', () => {
    // Hand-edit case: artists.{column} was set without a corresponding
    // reconciliation_log row. Tag the fallback so post-run audit can detect.
    const row = baseRow({ id: 100, artist_name: 'Stereolab', discogs_artist_id: 12345 });

    const outcome = resolveS2(row, buildIndex([]));

    if (outcome.status !== 'match') throw new Error('expected match');
    expect(outcome.sourceRows).toHaveLength(1);
    expect(outcome.sourceRows[0].method).toBe('alias_match');
    expect(outcome.sourceRows[0].confidence).toBeCloseTo(0.85);
    expect(outcome.sourceRows[0].notes).toBe('backfill:S2,fallback=no-log');
  });

  it('falls back to alias_match 0.85 when reconciliation_log confidence is null', () => {
    // Older log rows may have NULL confidence per LML's schema. Treat as the
    // same audit-flagged fallback (we have a method but no quantified
    // confidence; use the conservative interim).
    const row = baseRow({ id: 100, artist_name: 'Stereolab', discogs_artist_id: 12345 });
    const index = buildIndex([['Stereolab', 'discogs', { method: 'manual', confidence: null }]]);

    const outcome = resolveS2(row, index);

    if (outcome.status !== 'match') throw new Error('expected match');
    expect(outcome.sourceRows[0].method).toBe('alias_match');
    expect(outcome.sourceRows[0].confidence).toBeCloseTo(0.85);
    expect(outcome.sourceRows[0].notes).toBe('backfill:S2,fallback=null-confidence');
  });

  it('populates agreementSources with all populated source names when ≥2 sources are present', () => {
    const row = baseRow({
      id: 100,
      artist_name: 'Stereolab',
      discogs_artist_id: 12345,
      wikidata_qid: 'Q483507',
      musicbrainz_artist_id: 'mb-uuid',
    });
    const outcome = resolveS2(row, buildIndex([]));

    if (outcome.status !== 'match') throw new Error('expected match');
    expect(outcome.agreementSources.sort()).toEqual(['discogs_artist', 'mb_artist', 'wikidata']);
  });

  it('returns empty agreementSources when only one source is populated', () => {
    const row = baseRow({ id: 100, artist_name: 'Stereolab', discogs_artist_id: 12345 });
    const outcome = resolveS2(row, buildIndex([]));
    if (outcome.status !== 'match') throw new Error('expected match');
    expect(outcome.agreementSources).toEqual([]);
  });

  it('maps each artists column to the correct source name', () => {
    // Lock the column→source mapping. Drift here would silently corrupt
    // library_identity_source PK uniqueness or prevent cross-source
    // agreement detection.
    const row = baseRow({
      id: 100,
      artist_name: 'Stereolab',
      discogs_artist_id: 12345,
      musicbrainz_artist_id: 'aaaa-bbbb',
      wikidata_qid: 'Q42',
      spotify_artist_id: 'spot-xyz',
      apple_music_artist_id: 'am-123',
      bandcamp_id: 'stereolab',
    });

    const outcome = resolveS2(row, buildIndex([]));

    if (outcome.status !== 'match') throw new Error('expected match');
    const map = new Map(outcome.sourceRows.map((r) => [r.source, r.external_id]));
    expect(map.get('discogs_artist')).toBe('12345');
    expect(map.get('mb_artist')).toBe('aaaa-bbbb');
    expect(map.get('wikidata')).toBe('Q42');
    expect(map.get('spotify')).toBe('spot-xyz');
    expect(map.get('apple_music')).toBe('am-123');
    expect(map.get('bandcamp')).toBe('stereolab');
  });
});
