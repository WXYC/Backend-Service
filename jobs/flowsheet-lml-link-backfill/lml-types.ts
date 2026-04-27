/**
 * Minimal slice of LML's LookupResponse needed by the resolver.
 *
 * Mirrors `LookupResponse` from @wxyc/shared/dtos. Inlined so the job package
 * doesn't pull @wxyc/shared (a private GitHub Packages dep) at build time.
 * Kept in sync with `jobs/library-canonical-entity-backfill/lml-types.ts` —
 * both jobs interpret the same LML signal.
 */

export type LmlLookupResultItem = {
  library_item: { id: number };
  artwork?: { release_id: number };
};

export type LmlLookupResponse = {
  results: LmlLookupResultItem[];
  search_type: 'direct' | 'fallback' | 'alternative' | 'compilation' | 'song_as_artist' | 'none';
  song_not_found?: boolean;
  found_on_compilation?: boolean;
  context_message?: string;
  corrected_artist?: string;
};
