/**
 * Minimal slice of LML's LookupResponse needed by `enrich.ts`.
 *
 * Mirrors a subset of `LookupResponse` from @wxyc/shared/dtos. Inlined so
 * the job package doesn't pull @wxyc/shared (a private GitHub Packages dep)
 * at build time — see `jobs/library-canonical-entity-backfill/lml-types.ts`
 * for the same isolation reason.
 *
 * The artwork shape here is wider than B-1.2's lml-types.ts because this
 * job writes 10 columns from artwork (B-1.2 only reads release_id /
 * library_item.id).
 */

export type LmlArtwork = {
  release_id?: number;
  release_url?: string;
  artwork_url?: string | null;
  release_year?: number | null;
  artist_bio?: string | null;
  wikipedia_url?: string | null;
  spotify_url?: string | null;
  apple_music_url?: string | null;
  youtube_music_url?: string | null;
  bandcamp_url?: string | null;
  soundcloud_url?: string | null;
};

export type LmlLookupResultItem = {
  library_item: { id: number };
  artwork?: LmlArtwork | null;
};

export type LmlLookupResponse = {
  results: LmlLookupResultItem[];
  search_type: 'direct' | 'fallback' | 'alternative' | 'compilation' | 'song_as_artist' | 'none';
  song_not_found?: boolean;
  found_on_compilation?: boolean;
  context_message?: string;
  corrected_artist?: string;
};
