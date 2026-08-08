/**
 * Minimal mirror of LML's `bulk-resolve-libraries` contract.
 *
 * Source of truth: `WXYC/wxyc-shared/api.yaml` v1.33.0 (PRs #300, #307, #315
 * — BS#1991 / #801 S2). Endpoint:
 *   POST /api/v1/identity/bulk-resolve-libraries
 *
 * Inlined so the consumer job's build graph stays decoupled from
 * `@wxyc/shared` (which lives on GitHub Packages and would couple the
 * container image to the registry). Same isolation rationale as
 * `jobs/flowsheet-metadata-backfill/lml-types.ts`.
 *
 * Only the subset the writer touches is mirrored — additional fields LML
 * may return (e.g., debug hints) are tolerated by TypeScript's structural
 * typing and ignored.
 */

/**
 * One row from the SELECT predicate, sent to LML as a (library_id,
 * artist_name, album_title, legacy_release_id) tuple.
 *
 * `legacy_release_id` (BS#1991 AC, from the LML#1021 implementation round)
 * bridges to LML's per-track store, which is keyed by library.db's legacy
 * MySQL `LIBRARY_RELEASE_ID` — not `wxyc_schema.library.id`. Post-migration
 * 0137 (BS#1963) the column is NOT NULL on every `library` row, so this
 * consumer always has a real value to project; sending `null` would be a
 * projection bug, not a data state.
 */
export type BulkResolveInput = {
  library_id: number;
  artist_name: string;
  album_title: string;
  legacy_release_id: number;
};

/** `library_identity_source.source` enum values that LML emits. */
export type IdentitySource = 'discogs' | 'musicbrainz' | 'wikidata' | 'spotify' | 'apple_music' | 'bandcamp';

/** `library_identity_source.method` enum values that LML emits. */
export type IdentityMethod =
  | 'manual'
  | 'cross_source_agreement'
  | 'exact_match'
  | 'name_variation'
  | 'member_group'
  | 'alias_match'
  | 'trigram'
  | 'llm';

/**
 * Artist-level reconciled IDs. Per the BS#800 cross-cache-identity pivot,
 * LML is sole composer; this payload is what Backend writes into the
 * denormalised main row (plus the per-source provenance entries).
 *
 * NOTE: only fields with a destination column on `library_identity` are
 * surfaced here. The artist-level IDs without main-row columns
 * (`discogs_artist_id`, `musicbrainz_artist_id`, `bandcamp_id`) still flow
 * through `BulkResolveProvenanceEntry.external_id` per source, so no data
 * is dropped — the main row is a partial view until a follow-up migration
 * adds the columns.
 */
export type ReconciledIdentity = {
  // Per api.yaml v1.2.0: discogs_artist_id is integer (Discogs's native int ID);
  // the rest are strings (MB UUID, Wikidata QID, etc.). Keep these aligned with
  // the OpenAPI schema — a mistype here will silently double-coerce once the
  // follow-up migration adds main-row destinations for the artist-level IDs.
  discogs_artist_id?: number | null;
  musicbrainz_artist_id?: string | null;
  wikidata_qid?: string | null;
  spotify_artist_id?: string | null;
  apple_music_artist_id?: string | null;
  bandcamp_id?: string | null;
};

export type BulkResolveProvenanceEntry = {
  source: IdentitySource;
  method: IdentityMethod;
  confidence: number | null;
  external_id: string | null;
};

/**
 * One per-track credit entry for a `kind: 'compilation'` result (BS#1991,
 * settled on WXYC/wxyc-shared#297/#300, additive on api.yaml 1.30.0).
 *
 * `artist_name`/`track_title` are LML's echo of the `compilation_track_artist`
 * row it matched against — the join key back to CTA (fetch the page's CTA
 * rows once, match in memory; no join-back query per entry). `track_title`
 * mirrors CTA's own nullable column (a titleless credit is legitimate domain
 * state, not a sentinel). `resolved_artist_name` is LML's composed verdict:
 * `null` means the matcher could not identify who performed this track (a
 * "miss" — no BS write); non-null but absent from WXYC's `artists` catalog
 * resolves locally to a `null` `track_artist_id` (#801 D9 — expected, not an
 * error). `confidence` is the composed track-level confidence LML computed;
 * `track_position`, when present, is written verbatim (no normalization) per
 * #801 D7's position-rider AC — see `writer.ts`.
 */
export type BulkResolveTrackEntry = {
  artist_name: string;
  track_title: string | null;
  track_position: string | null;
  resolved_artist_name: string | null;
  confidence: number | null;
};

export type BulkResolveResult =
  | {
      kind: 'single_artist';
      library_id: number;
      main: ReconciledIdentity;
      method: IdentityMethod;
      confidence: number;
      provenance: BulkResolveProvenanceEntry[];
    }
  | {
      kind: 'compilation';
      library_id: number;
      method?: IdentityMethod;
      confidence?: number;
      provenance: BulkResolveProvenanceEntry[];
      /**
       * Per-track credits. Only meaningful alongside `tracks_attempted` and
       * the response-level `tracks_contract_version` — see
       * `isCompilationTracksAttempted` in `orchestrate.ts` for the four-state
       * read (WXYC/Backend-Service#1991 issue comments 2026-08-07).
       */
      tracks?: BulkResolveTrackEntry[];
      /**
       * Whether LML's per-track matcher visited this row this call. `true`
       * with an empty `tracks` means "ran, matched nothing" — still a
       * resolved exit, not a reason to re-ask. `false` (or absent) means the
       * matcher hasn't reached this row yet. A producer bug pairing
       * `tracks_attempted: false` with a non-empty `tracks` MUST be read as
       * `true` (api.yaml 1.31.0 consumer-reading mitigation).
       */
      tracks_attempted?: boolean | null;
    }
  | {
      kind: 'unresolved';
      library_id: number;
      provenance: BulkResolveProvenanceEntry[];
    };

export type CacheStats = Record<string, number>;

export type BulkResolveResponse = {
  results: BulkResolveResult[];
  cache_stats?: CacheStats;
  /**
   * Response-level (not per-result) marker, present and `1` only when the
   * producer understood `include_tracks: true` on the request (api.yaml
   * 1.31.0 / WXYC/wxyc-shared#303 Q1). Absent — including from every
   * producer that predates this field — means every result's
   * `tracks_attempted`/`tracks` pairing must be read as "not yet askable",
   * never as "resolved-empty".
   */
  tracks_contract_version?: number;
};
