/**
 * The album-metadata read projection, as ONE definition (BS#2103).
 *
 * Two public surfaces serve the same per-play enrichment:
 *   - `GET /flowsheet` (+ `/v2/flowsheet`) via `FSEntryFieldsRaw` in
 *     `apps/backend/services/flowsheet.service.ts`;
 *   - the legacy `GET /playlists/recentEntries?v=2` grouped payload via
 *     `enrichPlaycutMetadata` in
 *     `apps/backend/services/playlist-proxy.service.ts` (BS#2103 — shipped
 *     iOS 3.2 clients read the legacy endpoint but decode the full metadata
 *     set).
 *
 * They differ in wire key casing (snake_case vs camelCase) and in which
 * fields they emit, but the *derivation* of each value must not fork. Two
 * behaviors here are load-bearing and were each a bug once:
 *
 *   1. Every scalar is `coalesce(album_metadata.X, flowsheet.X)` — the
 *      per-album row when present, the inline flowsheet column otherwise
 *      (Epic D / BS#897). A plain `album_metadata` read silently drops
 *      enrichment for free-form plays, which have no `album_id` and carry
 *      their metadata inline.
 *   2. `spotify_url` / `apple_music_url` are host-guarded on the way out
 *      (BS#1714) by {@link suppressMislabeledStreamingUrls}. A value whose
 *      host isn't Spotify/Apple was mislabeled at the LML boundary before
 *      #1712 shipped and must not reach the hardwired iOS
 *      "Spotify"/"Apple Music" buttons.
 *
 * A consumer selecting these fields must join both sides the same way the
 * `/flowsheet` read paths do:
 *
 *   .leftJoin(library, eq(library.id, flowsheet.album_id))
 *   .leftJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
 *
 * (`library` is only needed for the sibling `artist_id` / `on_streaming` /
 * `discogs_unavailable` reads, which are NOT part of this projection — they
 * come off `library` directly.)
 */
import { album_metadata, flowsheet } from '@wxyc/database';
import { sql } from 'drizzle-orm';
import { isSpotifyUrl, isAppleMusicUrl } from '@wxyc/lml-client';

/**
 * Every coalesced album-metadata field EXCEPT `artwork_url`.
 *
 * Split out for `playlist-proxy.service.ts`, which resolves artwork through
 * its own lookup-key query (`enrichPlaycuts`, the BS#1105 split-format
 * tie-break) and deliberately never reads `flowsheet.artwork_url` so Epic D's
 * D4 column drop (#900) stays unblocked for that path. Every other consumer
 * wants {@link ALBUM_METADATA_PROJECTION}.
 */
export const ALBUM_METADATA_PROJECTION_WITHOUT_ARTWORK = {
  // discogs_url additionally NULLIFs the '' synthetic-match sentinel LML
  // persists for streaming-only/artist-only matches (LML#401/#487) so it
  // never reaches the wire (BS#1628). NULLIF wraps the COALESCE — an ''
  // verdict in album_metadata stays authoritative over a stale inline URL
  // rather than falling through to it. The persisted '' is deliberate
  // (BS#1185 keys off it); only the projection normalizes.
  discogs_url: sql<string | null>`nullif(coalesce(${album_metadata.discogs_url}, ${flowsheet.discogs_url}), '')`,
  release_year: sql<number | null>`coalesce(${album_metadata.release_year}, ${flowsheet.release_year})`,
  spotify_url: sql<string | null>`coalesce(${album_metadata.spotify_url}, ${flowsheet.spotify_url})`,
  apple_music_url: sql<string | null>`coalesce(${album_metadata.apple_music_url}, ${flowsheet.apple_music_url})`,
  youtube_music_url: sql<string | null>`coalesce(${album_metadata.youtube_music_url}, ${flowsheet.youtube_music_url})`,
  bandcamp_url: sql<string | null>`coalesce(${album_metadata.bandcamp_url}, ${flowsheet.bandcamp_url})`,
  soundcloud_url: sql<string | null>`coalesce(${album_metadata.soundcloud_url}, ${flowsheet.soundcloud_url})`,
  artist_bio: sql<string | null>`coalesce(${album_metadata.artist_bio}, ${flowsheet.artist_bio})`,
  artist_wikipedia_url: sql<
    string | null
  >`coalesce(${album_metadata.artist_wikipedia_url}, ${flowsheet.artist_wikipedia_url})`,
  // genres/styles live ONLY on album_metadata (no inline flowsheet column to
  // COALESCE over), so these are plain column reads. BS#1441.
  genres: album_metadata.genres,
  styles: album_metadata.styles,
};

/**
 * The full `/flowsheet` album-metadata projection: `artwork_url` plus
 * {@link ALBUM_METADATA_PROJECTION_WITHOUT_ARTWORK}. Key order matches the
 * historical `FSEntryFieldsRaw` layout (artwork first).
 */
export const ALBUM_METADATA_PROJECTION = {
  artwork_url: sql<string | null>`coalesce(${album_metadata.artwork_url}, ${flowsheet.artwork_url})`,
  ...ALBUM_METADATA_PROJECTION_WITHOUT_ARTWORK,
};

/** The two host-guarded streaming fields (BS#1714). */
export interface StreamingUrlPair {
  spotify_url: string | null;
  apple_music_url: string | null;
}

/**
 * BS#1714 serve-seam guard: suppress a persisted `spotify_url` /
 * `apple_music_url` whose host isn't Spotify / Apple (mislabeled at the LML
 * boundary before #1712 shipped) so it never reaches the hardwired iOS
 * "Spotify" / "Apple Music" button. No synthesized fallback exists at this
 * seam, so a mislabeled value drops to `null`.
 *
 * Every read surface that emits these two fields must run them through here.
 */
export function suppressMislabeledStreamingUrls(raw: StreamingUrlPair): StreamingUrlPair {
  return {
    spotify_url: isSpotifyUrl(raw.spotify_url) ? raw.spotify_url : null,
    apple_music_url: isAppleMusicUrl(raw.apple_music_url) ? raw.apple_music_url : null,
  };
}
