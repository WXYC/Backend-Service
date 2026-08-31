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
 *
 * A THIRD behavior lives one layer up, not here (#2339): when the COALESCE
 * above (plus the host guard) still leaves a streaming URL absent, the two
 * serializer seams — `transformToIFSEntry` in `flowsheet.service.ts` and
 * `applyPlaycutMetadata` in `playlist-proxy.service.ts` — fill it with a
 * synthesized search URL via {@link fillSynthesizedSearchUrls}, mirroring
 * `GET /proxy/metadata/album`'s degradation (BS#1184/#1185). It is
 * deliberately NOT folded into this SQL projection: URL-encoding
 * artist/album/track text is a TS concern (`SearchUrlProvider` /
 * `synthesizeSearchUrls`), and — more importantly — this projection is a
 * pure read of persisted state, while a synthesized URL must never be
 * persisted (#1192 — a synthesized Spotify/Apple link would launder a
 * "couldn't verify" signal into a clickable button on disk). Keeping
 * synthesis in TS, downstream of this SELECT, keeps that boundary visible:
 * nothing this projection returns is ever fabricated, only coalesced.
 */
import { album_metadata, flowsheet } from '@wxyc/database';
import { sql } from 'drizzle-orm';
import { isSpotifyUrl, isAppleMusicUrl } from '@wxyc/lml-client';
import { SearchUrlProvider } from '../services/metadata/providers/search-urls.provider.js';

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

/** The five request-time-synthesizable streaming URL fields (#2339). */
export interface SynthesizableStreamingUrls {
  spotify_url: string | null;
  apple_music_url: string | null;
  youtube_music_url: string | null;
  bandcamp_url: string | null;
  soundcloud_url: string | null;
}

const searchUrlProvider = new SearchUrlProvider();

/**
 * Request-time fallback fill (#2339): whatever is still `null` after the
 * COALESCE + BS#1714 host guard gets a synthesized search URL, the same
 * `SearchUrlProvider.getAllSearchUrls` degradation `GET /proxy/metadata/album`
 * already applies at request time (BS#1184/#1185). A populated value — verified
 * or already-suppressed-then-filled — always wins; this only fills absences.
 * Never persisted (#1192): callers must apply this to the *response* object,
 * never write the result back to `album_metadata` or `flowsheet`.
 *
 * Requires a non-blank `artist_name` to have anything to search on — mirrors
 * `FSEntryFieldsRaw.rotation_bin`'s "looks like a real track" gate just above
 * it in `flowsheet.service.ts`. A marker/talkset/breakpoint row (or a track
 * row that somehow lost its artist name) degrades to nulls exactly as before.
 */
export function fillSynthesizedSearchUrls(
  urls: SynthesizableStreamingUrls,
  text: { artist_name: string | null; album_title: string | null; track_title: string | null }
): SynthesizableStreamingUrls {
  if (!text.artist_name) return urls;
  if (
    urls.spotify_url !== null &&
    urls.apple_music_url !== null &&
    urls.youtube_music_url !== null &&
    urls.bandcamp_url !== null &&
    urls.soundcloud_url !== null
  ) {
    return urls;
  }

  const fallback = searchUrlProvider.getAllSearchUrls(
    text.artist_name,
    text.album_title ?? undefined,
    text.track_title ?? undefined
  );
  return {
    spotify_url: urls.spotify_url ?? fallback.spotifyUrl,
    apple_music_url: urls.apple_music_url ?? fallback.appleMusicUrl,
    youtube_music_url: urls.youtube_music_url ?? fallback.youtubeMusicUrl,
    bandcamp_url: urls.bandcamp_url ?? fallback.bandcampUrl,
    soundcloud_url: urls.soundcloud_url ?? fallback.soundcloudUrl,
  };
}
