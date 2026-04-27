/**
 * Minimal slice of LML's LookupResponse needed by the resolver.
 *
 * Mirrors `LookupResponse` from @wxyc/shared/dtos. Inlined so the job package
 * doesn't pull @wxyc/shared (a private GitHub Packages dep) at build time —
 * the rest of the LML response (cache_stats, song_not_found, etc.) is unused
 * here and would just be dead weight.
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
