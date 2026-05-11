/**
 * Minimal mirror of LML's `bulk-resolve-libraries` contract.
 *
 * Source of truth: `WXYC/wxyc-shared/api.yaml` v1.2.0 (PR #104). Endpoint:
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
 * artist_name, album_title) tuple.
 */
export type BulkResolveInput = {
  library_id: number;
  artist_name: string;
  album_title: string;
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
  discogs_artist_id?: string | null;
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

/** Per-track identity for compilation rows. Not consumed in BS#802. */
export type BulkResolveTrackIdentity = Record<string, unknown>;

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
      tracks?: BulkResolveTrackIdentity[];
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
};
