/**
 * Main-row recompute for `library_identity` (§3.4.1.1 — composition rules).
 *
 * Given the per-source rows that exist for a single library_id (i.e., the
 * current contents of `library_identity_source` after the writer's per-source
 * upserts), produce the values that the main `library_identity` row should
 * hold. The result is what the writer UPSERTs onto the main table.
 *
 * Composition rules (locked, from
 * `plans/library-hook-canonicalization/section-4-step-2-backfill-plan.md`
 * §5.1.1, which restates the parent plan §3.4.1.1):
 *
 *   Rule 1 — manual hard floor. Any per-source row with method='manual' pins
 *            the main row to (manual, 1.00). Cannot be demoted by automation.
 *   Rule 2 — agreement boost. When two-or-more non-inherited corroborating
 *            sources are passed in, main becomes (cross_source_agreement,
 *            MAX(0.95, MIN-of-corroborating-confidences)).
 *   Rule 3 — inherited rows do not contribute to agreement (carry weaker
 *            epistemic weight by definition).
 *   Rule 4 — fallback when no agreement: main inherits the (method, confidence)
 *            of the MIN-confidence per-source row (most cautious).
 *   Rule 5 — supersedure / demotion is the writer's concern; this function
 *            simply computes the "should be" state. Per §5.1.1, demoting
 *            (e.g. exact_match 1.00 → cross_source_agreement 0.95) is
 *            considered evidence-positive because corroborated > single, and
 *            the writer always UPSERTs unconditionally with history.
 *
 * Sub-PR 2.0 only writes single-source S1 rows, but the function is fully
 * implemented across the §5.1.1 worked-example matrix so 2.1+ cannot drift
 * the contract without a unit-test failure.
 *
 * The `agreementSources` array names which per-source `source` values are
 * cross-referenced by the caller's cross-ref index (§5.2). Callers that have
 * not built the index yet (i.e., 2.0) pass `[]`.
 */

export type SourceRow = {
  /** Source identifier — e.g., 'discogs_release', 'discogs_artist', 'wikidata'. */
  source: string;
  /** External ID at the named source. Numeric IDs arrive as strings. */
  external_id: string;
  /** §3.4.1 method enum. */
  method: string;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Optional list of sources that boosted this row's confidence (sub-PR 2.1+). */
  boost_sources: string | null;
  /** Source-supplied last-verified timestamp; defaults to now() at the writer. */
  last_verified_at?: Date;
};

export type MainRowFields = {
  discogs_master_id: number | null;
  discogs_release_id: number | null;
  musicbrainz_release_group_mbid: string | null;
  musicbrainz_release_mbid: string | null;
  musicbrainz_recording_mbid: string | null;
  wikidata_qid: string | null;
  spotify_id: string | null;
  apple_music_id: string | null;
  method: string;
  confidence: number;
  agreement_sources: string | null;
  last_verified_at: Date;
};

/**
 * Maps a per-source `source` value to the main row's external-ID column.
 * Sources not in this table are artist-level (or otherwise not surfaced in
 * the main row) and contribute only to confidence/agreement composition.
 *
 * Sub-PR 2.0 only writes `discogs_release`. The other entries are pre-locked
 * so 2.1-2.3 don't have to extend this map. Adding a new release-level
 * source in a future sub-PR means adding both a row here AND extending the
 * substrate schema (out of scope per §6).
 */
const RELEASE_LEVEL_SOURCE_TO_COLUMN: Record<string, keyof MainRowFields> = {
  discogs_master: 'discogs_master_id',
  discogs_release: 'discogs_release_id',
  mb_release_group: 'musicbrainz_release_group_mbid',
  mb_release: 'musicbrainz_release_mbid',
  mb_recording: 'musicbrainz_recording_mbid',
  wikidata: 'wikidata_qid',
  spotify: 'spotify_id',
  apple_music: 'apple_music_id',
};

const CROSS_SOURCE_AGREEMENT_FLOOR = 0.95;

/**
 * Parse the external_id into the right shape for the column. Discogs IDs are
 * integers; everything else is text.
 */
const parseExternalId = (column: keyof MainRowFields, raw: string): number | string => {
  if (column === 'discogs_master_id' || column === 'discogs_release_id') {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) {
      throw new Error(`Expected integer external_id for ${String(column)}, got ${JSON.stringify(raw)}`);
    }
    return parsed;
  }
  return raw;
};

/**
 * Compute the main-row values for a library_id given its per-source rows and
 * the (possibly empty) list of sources verified to corroborate via the
 * cross-ref index.
 *
 * Throws on an empty rows array — the writer should not call recompute when
 * no per-source rows exist for the library_id (the main row should be
 * deleted instead).
 */
export const recomputeMainRow = (rows: SourceRow[], agreementSources: string[]): MainRowFields => {
  if (rows.length === 0) {
    throw new Error('recomputeMainRow called with no per-source rows; expected at least one.');
  }

  // External-ID column population: take the per-source row's external_id and
  // write it to the matching main-row column. If two rows pin the same column
  // (e.g., two `discogs_release` rows — should not happen given the per-source
  // PK is (library_id, source), but defensive), the last one wins. The PK
  // guarantee makes this practically unreachable.
  const main: MainRowFields = {
    discogs_master_id: null,
    discogs_release_id: null,
    musicbrainz_release_group_mbid: null,
    musicbrainz_release_mbid: null,
    musicbrainz_recording_mbid: null,
    wikidata_qid: null,
    spotify_id: null,
    apple_music_id: null,
    method: 'exact_match',
    confidence: 1.0,
    agreement_sources: null,
    last_verified_at: new Date(0),
  };

  for (const row of rows) {
    const column = RELEASE_LEVEL_SOURCE_TO_COLUMN[row.source];
    if (column !== undefined) {
      const value = parseExternalId(column, row.external_id);
      // Cast through unknown — every column in the lookup table accepts the
      // parseExternalId return type for that column.
      (main as unknown as Record<string, unknown>)[column] = value;
    }
    if (row.last_verified_at && row.last_verified_at > main.last_verified_at) {
      main.last_verified_at = row.last_verified_at;
    }
  }

  // Rule 1: manual hard floor. Any manual row pins the main row.
  const manualRow = rows.find((r) => r.method === 'manual');
  if (manualRow) {
    main.method = 'manual';
    main.confidence = 1.0;
    main.agreement_sources = null;
    return main;
  }

  // Rule 2: agreement boost. Need >= 2 non-inherited rows whose source names
  // appear in agreementSources (§3.2.5 cross-ref result).
  const corroboratingRows = rows.filter((r) => r.method !== 'inherited' && agreementSources.includes(r.source));
  if (corroboratingRows.length >= 2) {
    const minCorroboratingConfidence = Math.min(...corroboratingRows.map((r) => r.confidence));
    main.method = 'cross_source_agreement';
    main.confidence = Math.max(CROSS_SOURCE_AGREEMENT_FLOOR, minCorroboratingConfidence);
    main.agreement_sources = corroboratingRows
      .map((r) => r.source)
      .slice()
      .sort()
      .join(',');
    return main;
  }

  // Rule 4: fallback to the MIN-confidence row's (method, confidence). Inherited
  // rows DO participate here — they're excluded from agreement (Rule 3) but
  // still constrain the fallback main row.
  let minRow = rows[0];
  for (const r of rows) {
    if (r.confidence < minRow.confidence) minRow = r;
  }
  main.method = minRow.method;
  main.confidence = minRow.confidence;
  main.agreement_sources = null;
  return main;
};
