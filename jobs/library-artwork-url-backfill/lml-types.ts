/**
 * Minimal slice of LML's LookupResponse needed by `enrich.ts`.
 *
 * Mirrors a subset of `LookupResponse` from @wxyc/shared/dtos. Inlined so the
 * job package doesn't pull @wxyc/shared (a private GitHub Packages dep) at
 * build time — same isolation reason as `flowsheet-metadata-backfill/lml-types.ts`.
 *
 * Slimmer than the flowsheet-metadata-backfill copy: this job writes a single
 * column (`library.artwork_url`) so only the artwork URL field matters. Other
 * Discogs fields (release_year, spotify_url, etc.) live on `flowsheet`, not
 * `library`, and are out of scope per #637.
 */

export type LmlArtwork = {
  artwork_url?: string | null;
};

export type LmlLookupResultItem = {
  library_item: { id: number };
  artwork?: LmlArtwork | null;
};

export type LmlLookupResponse = {
  results: LmlLookupResultItem[];
  search_type: 'direct' | 'fallback' | 'alternative' | 'compilation' | 'song_as_artist' | 'none';
};
