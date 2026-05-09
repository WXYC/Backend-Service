/**
 * Unit tests for the library-identity main-row recompute function (§3.4.1.1).
 *
 * Exercises the worked-example matrix in `plans/library-hook-canonicalization/
 * section-4-step-2-backfill-plan.md` §5.1.1 — the public API every sub-PR
 * (2.0 → 2.4) calls into when composing the `library_identity` main row from
 * the per-source rows in `library_identity_source`.
 *
 * Sub-PR 2.0 only writes single-source rows (S1: `discogs_release`), but the
 * recompute is unit-tested across all four worked-example shapes here so 2.1+
 * cannot drift the contract silently. The §5.1.1 fixture is the locked spec.
 */
import {
  recomputeMainRow,
  type SourceRow,
  type MainRowFields,
} from '../../../../jobs/library-identity-backfill/recompute';

const baseRow = (overrides: Partial<SourceRow>): SourceRow => ({
  source: 'discogs_release',
  external_id: '987654',
  method: 'exact_match',
  confidence: 1.0,
  boost_sources: null,
  ...overrides,
});

describe('recomputeMainRow — §3.4.1.1 worked-example matrix', () => {
  it('Row 1 — S1 alone: exact_match 1.00, agreement_sources=NULL', () => {
    const rows: SourceRow[] = [baseRow({ source: 'discogs_release', external_id: '987654' })];

    const main = recomputeMainRow(rows, []);

    expect(main.method).toBe('exact_match');
    expect(main.confidence).toBeCloseTo(1.0);
    expect(main.agreement_sources).toBeNull();
    expect(main.discogs_release_id).toBe(987654);
    expect(main.discogs_master_id).toBeNull();
    expect(main.musicbrainz_release_group_mbid).toBeNull();
    expect(main.musicbrainz_release_mbid).toBeNull();
    expect(main.musicbrainz_recording_mbid).toBeNull();
    expect(main.wikidata_qid).toBeNull();
    expect(main.spotify_id).toBeNull();
    expect(main.apple_music_id).toBeNull();
  });

  it('Row 2 — S1 + S2 no cross-ref: alias_match 0.85 (Rule 4: MIN)', () => {
    // Two sources, no cross-reference. Per Rule 4 the main row inherits the
    // minimum-confidence row's method+confidence — alias_match 0.85 here.
    const rows: SourceRow[] = [
      baseRow({ source: 'discogs_release', external_id: '987654', method: 'exact_match', confidence: 1.0 }),
      baseRow({ source: 'discogs_artist', external_id: '12345', method: 'alias_match', confidence: 0.85 }),
    ];

    const main = recomputeMainRow(rows, []);

    expect(main.method).toBe('alias_match');
    expect(main.confidence).toBeCloseTo(0.85);
    expect(main.agreement_sources).toBeNull();
    expect(main.discogs_release_id).toBe(987654);
  });

  it('Row 3 — S1 + S2 with cross-ref: cross_source_agreement 0.95 (Rule 2)', () => {
    // Per Rule 2: confidence = MAX(0.95, MIN-of-corroborating-confidences) =
    // MAX(0.95, MIN(1.00, 0.85)) = MAX(0.95, 0.85) = 0.95.
    const rows: SourceRow[] = [
      baseRow({ source: 'discogs_release', external_id: '987654', method: 'exact_match', confidence: 1.0 }),
      baseRow({ source: 'discogs_artist', external_id: '12345', method: 'alias_match', confidence: 0.85 }),
    ];
    const agreementSources = ['discogs_release', 'discogs_artist'];

    const main = recomputeMainRow(rows, agreementSources);

    expect(main.method).toBe('cross_source_agreement');
    expect(main.confidence).toBeCloseTo(0.95);
    expect(main.agreement_sources).toBe('discogs_artist,discogs_release');
  });

  it('Row 4 — S1 + S2 + S5 with cross-ref: cross_source_agreement 0.95, includes all three', () => {
    const rows: SourceRow[] = [
      baseRow({ source: 'discogs_release', external_id: '987654', method: 'exact_match', confidence: 1.0 }),
      baseRow({ source: 'discogs_artist', external_id: '12345', method: 'alias_match', confidence: 0.85 }),
      baseRow({ source: 'wikidata', external_id: 'Q123', method: 'alias_match', confidence: 0.85 }),
    ];
    const agreementSources = ['discogs_release', 'discogs_artist', 'wikidata'];

    const main = recomputeMainRow(rows, agreementSources);

    expect(main.method).toBe('cross_source_agreement');
    expect(main.confidence).toBeCloseTo(0.95);
    // sorted lex
    expect(main.agreement_sources).toBe('discogs_artist,discogs_release,wikidata');
    expect(main.wikidata_qid).toBe('Q123');
  });
});

describe('recomputeMainRow — Rule 1 (manual hard floor)', () => {
  it('a single manual row pins the main row to manual 1.00 regardless of other inputs', () => {
    // Manual entries cannot be demoted by automated cross-source agreement —
    // human wins. Acceptance per §3.4.1.1 Rule 1.
    const rows: SourceRow[] = [
      baseRow({ source: 'discogs_release', external_id: '987654', method: 'manual', confidence: 1.0 }),
      baseRow({ source: 'discogs_artist', external_id: '12345', method: 'alias_match', confidence: 0.85 }),
    ];

    const main = recomputeMainRow(rows, ['discogs_release', 'discogs_artist']);

    expect(main.method).toBe('manual');
    expect(main.confidence).toBeCloseTo(1.0);
    expect(main.agreement_sources).toBeNull();
  });
});

describe('recomputeMainRow — Rule 3 (inherited excluded from agreement)', () => {
  it('two corroborating sources where one is inherited do not trigger Rule 2', () => {
    // `inherited` is the artist→release fanout marker (sub-PR 2.1 details).
    // It carries lower epistemic weight by definition (×0.95 multiplier per
    // §3.4.1) and per Rule 3 must not contribute to cross_source_agreement.
    const rows: SourceRow[] = [
      baseRow({ source: 'discogs_release', external_id: '987654', method: 'exact_match', confidence: 1.0 }),
      baseRow({ source: 'discogs_artist', external_id: '12345', method: 'inherited', confidence: 0.95 }),
    ];
    const agreementSources = ['discogs_release', 'discogs_artist'];

    const main = recomputeMainRow(rows, agreementSources);

    expect(main.method).not.toBe('cross_source_agreement');
    // Rule 4 fallback: MIN of non-inherited rows is just the discogs_release
    // row (1.00); the inherited row is filtered out of agreement BUT still
    // counts in the MIN for non-agreement cases.
    expect(main.method).toBe('inherited');
    expect(main.confidence).toBeCloseTo(0.95);
  });
});

describe('recomputeMainRow — external-ID column mapping', () => {
  it('maps each per-source row to the right main-row external-ID column', () => {
    const rows: SourceRow[] = [
      baseRow({ source: 'discogs_master', external_id: '5000', method: 'exact_match', confidence: 1.0 }),
      baseRow({ source: 'discogs_release', external_id: '987654', method: 'exact_match', confidence: 1.0 }),
      baseRow({
        source: 'mb_release_group',
        external_id: '550e8400-e29b-41d4-a716-446655440000',
        method: 'exact_match',
        confidence: 1.0,
      }),
      baseRow({
        source: 'mb_release',
        external_id: '550e8400-e29b-41d4-a716-446655440001',
        method: 'exact_match',
        confidence: 1.0,
      }),
      baseRow({
        source: 'mb_recording',
        external_id: '550e8400-e29b-41d4-a716-446655440002',
        method: 'exact_match',
        confidence: 1.0,
      }),
      baseRow({ source: 'wikidata', external_id: 'Q42', method: 'exact_match', confidence: 1.0 }),
      baseRow({ source: 'spotify', external_id: '4tZwfgrHOc3mvqYlEYSvVi', method: 'exact_match', confidence: 1.0 }),
      baseRow({ source: 'apple_music', external_id: '1440643737', method: 'exact_match', confidence: 1.0 }),
    ];

    const main: MainRowFields = recomputeMainRow(rows, []);

    expect(main.discogs_master_id).toBe(5000);
    expect(main.discogs_release_id).toBe(987654);
    expect(main.musicbrainz_release_group_mbid).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(main.musicbrainz_release_mbid).toBe('550e8400-e29b-41d4-a716-446655440001');
    expect(main.musicbrainz_recording_mbid).toBe('550e8400-e29b-41d4-a716-446655440002');
    expect(main.wikidata_qid).toBe('Q42');
    expect(main.spotify_id).toBe('4tZwfgrHOc3mvqYlEYSvVi');
    expect(main.apple_music_id).toBe('1440643737');
  });

  it('artist-level sources (discogs_artist, mb_artist, bandcamp) do not populate release-level main columns', () => {
    // Plan §5.1.1 + substrate: main row is release-level. Artist-level sources
    // contribute to confidence and agreement, but their external_ids do not
    // back-fill release-level columns.
    const rows: SourceRow[] = [
      baseRow({ source: 'discogs_artist', external_id: '12345', method: 'alias_match', confidence: 0.85 }),
      baseRow({ source: 'mb_artist', external_id: 'aaaa-bbbb', method: 'alias_match', confidence: 0.85 }),
      baseRow({ source: 'bandcamp', external_id: 'someone', method: 'alias_match', confidence: 0.85 }),
    ];

    const main = recomputeMainRow(rows, []);

    expect(main.discogs_master_id).toBeNull();
    expect(main.discogs_release_id).toBeNull();
    expect(main.musicbrainz_release_group_mbid).toBeNull();
    expect(main.musicbrainz_release_mbid).toBeNull();
    expect(main.musicbrainz_recording_mbid).toBeNull();
    // Confidence is still computed from these rows (alias_match 0.85)
    expect(main.method).toBe('alias_match');
    expect(main.confidence).toBeCloseTo(0.85);
  });
});

describe('recomputeMainRow — degenerate inputs', () => {
  it('throws on an empty rows array (every main row must descend from at least one source)', () => {
    expect(() => recomputeMainRow([], [])).toThrow();
  });

  it('uses the latest last_verified_at across rows', () => {
    const earlier = new Date('2026-01-01T00:00:00Z');
    const later = new Date('2026-05-08T00:00:00Z');
    const rows: SourceRow[] = [
      baseRow({ source: 'discogs_release', external_id: '987654', last_verified_at: earlier }),
      baseRow({
        source: 'discogs_artist',
        external_id: '12345',
        method: 'alias_match',
        confidence: 0.85,
        last_verified_at: later,
      }),
    ];

    const main = recomputeMainRow(rows, []);

    expect(main.last_verified_at).toEqual(later);
  });
});
