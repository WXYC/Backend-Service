/**
 * Minimal mirror of LML's `POST /api/v1/artists/search-aliases/bulk` contract.
 *
 * Source of truth: `WXYC/wxyc-shared/api.yaml` v1.9.0. Endpoint:
 *   POST /api/v1/artists/search-aliases/bulk
 *
 * Inlined so the consumer job's build graph stays decoupled from
 * `@wxyc/shared` (which lives on GitHub Packages and would couple the
 * container image to the registry). Same isolation rationale as
 * `jobs/library-identity-consumer/lml-types.ts`.
 *
 * Only the subset the writer touches is mirrored — additional fields LML
 * may return are tolerated by TypeScript's structural typing and ignored.
 */

/** `artist_search_alias.source` enum values that LML emits. */
export type ArtistSearchAliasSource =
  'discogs_name_variation' | 'discogs_alias' | 'discogs_member' | 'wxyc_library_alt';

/** `artist_search_alias.method` enum values that LML emits. */
export type ArtistSearchAliasMethod = 'name_variation' | 'alias_curated' | 'member_group' | 'alt_curated';

/**
 * One composed variant for an input artist name. `related_artist_id` is the
 * upstream Discogs artist id namespaced into `external_object_id` for member
 * / alias rows (LML uses `discogs:artist:{id}`); Backend stores that text
 * verbatim — joining it back to a local `artists.id` is a follow-up
 * (artist_id is null on first ingest).
 */
export type ArtistSearchAliasVariant = {
  source: ArtistSearchAliasSource;
  variant: string;
  method: ArtistSearchAliasMethod;
  confidence: number;
  related_artist_id: number | null;
  external_subject_id: string | null;
  external_object_id: string | null;
  active: boolean | null;
};

/**
 * Composed result for one input name. `sources_present` records which
 * composer legs actually ran for this name (independent of whether each leg
 * returned any variants) — the writer uses this to scope its reconcile
 * DELETE so a partial-composer response doesn't wipe out rows from other
 * sources.
 */
export type ArtistSearchAliasesResult = {
  name: string;
  variants: ArtistSearchAliasVariant[];
  sources_present: ArtistSearchAliasSource[];
};

export type ArtistSearchAliasesBulkRequest = {
  names: string[];
};

export type CacheStats = Record<string, number>;

export type ArtistSearchAliasesBulkResponse = {
  artists: ArtistSearchAliasesResult[];
  missing: string[];
  cache_stats?: CacheStats;
};
