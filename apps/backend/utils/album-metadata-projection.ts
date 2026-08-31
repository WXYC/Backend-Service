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
 * above (plus the host guard) still leaves a streaming URL absent, two
 * serializer seams fill it with a synthesized search URL via
 * {@link fillSynthesizedSearchUrls}, mirroring `GET /proxy/metadata/album`'s
 * degradation (BS#1184/#1185) — but only for a row that ALREADY carries at
 * least one real streaming URL. See that function for the gate and why it
 * exists.
 *
 * Exactly TWO seams fill, and both are read-GETs:
 *   - `transformToIFSEntry` in `flowsheet.service.ts` — serves the V1
 *     `GET /flowsheet` top-level fields AND `/v2/flowsheet`'s nested
 *     `metadata` object (both come off the one IFSEntry it builds);
 *   - `applyPlaycutMetadata` in `playlist-proxy.service.ts` — the legacy
 *     `GET /playlists/recentEntries?v=2` grouped payload.
 *
 * The other two producers of flowsheet-shaped payloads deliberately do NOT
 * fill, and neither routes through `transformToIFSEntry`:
 *   - the mutation/peek echoes (`projectFlowsheetEntry` in
 *     `utils/flowsheet-projection.ts`, an allow-list projection straight off
 *     the DB row — BS#1513);
 *   - the SSE `liveFs:update` channel (`pickClientFacingColumns`, same
 *     allow-list over a CDC row).
 * That asymmetry is safe precisely BECAUSE the fill is gated: the only bit
 * shipped iOS 3.2 branches on is "does this payload carry any streaming URL
 * at all" (`inline.streaming.hasAny`), and the gate can only fire on rows
 * where that bit is already true. So the gate-relevant bit never differs
 * between producers for the same row — only button decoration does.
 *
 * The fill is deliberately NOT folded into this SQL projection: URL-encoding
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
 * A persisted string that actually carries information, or `null`.
 *
 * `''` and whitespace-only values are treated as ABSENT, matching the
 * degradation `GET /proxy/metadata/album` already applies: its fallback arms
 * are plain falsy checks (`if (!metadata.spotifyUrl) …`), not `??`-nullish
 * ones, so a persisted `''` there earns a synthesized URL rather than
 * surviving to the wire. A `??` check here would instead let the blank
 * through, where the legacy seam's `wireUrl` drops it with no fallback
 * left to run and the V1 `/flowsheet` seam emits it verbatim as `""`.
 *
 * A non-blank value that is nonetheless unusable (scheme-relative, `javascript:`,
 * a raw-backslash parser differential) counts as PRESENT here, exactly as the
 * proxy's falsy check counts it — this helper's job is proxy parity, and the
 * legacy seam's `wireUrl` is the separate, later filter that decides whether
 * such a value earns a wire key.
 */
function nonBlank(value: string | null): string | null {
  if (value === null) return null;
  return value.trim() === '' ? null : value;
}

/**
 * Request-time fallback fill (#2339): fill a still-absent streaming URL with a
 * synthesized search URL — the same `SearchUrlProvider.getAllSearchUrls`
 * degradation `GET /proxy/metadata/album` applies at request time
 * (BS#1184/#1185) — for rows that qualify. Never persisted (#1192): callers
 * must apply this to the *response* object, never write the result back to
 * `album_metadata` or `flowsheet`.
 *
 * Inputs are the POST-host-guard values: `spotify_url` / `apple_music_url`
 * must already have been through {@link suppressMislabeledStreamingUrls}, so a
 * mislabeled URL degrades exactly as an outright-missing one does (#1714).
 *
 * TWO gates, both load-bearing:
 *
 *   1. **At least one real streaming URL already present** (owner decision,
 *      2026-08-31, on #2339). Shipped iOS 3.2's `PlaycutMetadataService`
 *      skips the live `/proxy/metadata/album` fetch when
 *      `metadataStatus?.isTerminal == true || inline.streaming.hasAny`. A row
 *      that already carries a real streaming URL short-circuits inline
 *      REGARDLESS of what we do, so filling it only upgrades grey
 *      Spotify/Apple buttons and can never suppress a fetch. A row with zero
 *      real streaming URLs must keep serving NULLs: filling it would satisfy
 *      `streaming.hasAny` and suppress the live proxy fallback — which
 *      returns full metadata AND synthesizes its own links — leaving the user
 *      a card with five search buttons and nothing else, permanently. That is
 *      BS#2103's empty-card bug, reopened. The post-#2295-drain cohort (the
 *      population this ticket exists for) qualifies: the drain persisted
 *      synthesized YouTube Music / Bandcamp / SoundCloud URLs on every matched
 *      row.
 *
 *      A row whose ONLY streaming URL was suppressed by the host guard counts
 *      as zero-streaming and serves NULLs — the proxy fallback then both
 *      fetches and synthesizes, consistent with #1714's degradation.
 *
 *      "Real" is non-null and non-blank, deliberately NOT "parses to a usable
 *      URL". That leaves one residual gap: a row whose only streaming value is
 *      non-blank yet unusable (scheme-relative, a raw-backslash parser
 *      differential) passes the gate here while the legacy seam's `wireUrl`
 *      drops it from the wire, so that row's `streaming.hasAny` does flip
 *      false -> true. The known population is nil — the enrichment write path
 *      only ever persists absolute URLs, and the two shapes in the wire golden
 *      (rows 9011 / 9013) are constructed hazards, not audit findings — and a
 *      URL-validity gate would have to differ per seam (the `/flowsheet` seam
 *      applies no such filter), which is exactly the fork BS#2103 exists to
 *      prevent. Revisit if such rows ever appear in the corpus.
 *
 *   2. **A non-blank `artist_name`** — there is nothing to search on without
 *      one, and a whitespace-only name would synthesize five buttons opening
 *      `%20%20%20` searches. A marker/talkset/breakpoint row (or a track row
 *      that somehow lost its artist name) degrades to nulls exactly as before.
 *
 * Blank (`''` / whitespace-only) persisted values are normalized to `null`
 * unconditionally — see {@link nonBlank} — whether or not the row qualifies
 * for the fill, so a blank never reaches a wire as `""`.
 */
export function fillSynthesizedSearchUrls(
  urls: SynthesizableStreamingUrls,
  text: { artist_name: string | null; album_title: string | null; track_title: string | null }
): SynthesizableStreamingUrls {
  const present: SynthesizableStreamingUrls = {
    spotify_url: nonBlank(urls.spotify_url),
    apple_music_url: nonBlank(urls.apple_music_url),
    youtube_music_url: nonBlank(urls.youtube_music_url),
    bandcamp_url: nonBlank(urls.bandcamp_url),
    soundcloud_url: nonBlank(urls.soundcloud_url),
  };

  // Gate 1: zero real streaming URLs -> serve NULLs, keep the 3.2 proxy fallback.
  const carriesRealStreamingUrl =
    present.spotify_url !== null ||
    present.apple_music_url !== null ||
    present.youtube_music_url !== null ||
    present.bandcamp_url !== null ||
    present.soundcloud_url !== null;
  if (!carriesRealStreamingUrl) return present;

  // Gate 2: nothing to search on.
  const artistName = text.artist_name?.trim() ?? '';
  if (artistName === '') return present;

  // Nothing absent -> nothing to build. O(rows) string work, so skip it.
  const hasAbsent =
    present.spotify_url === null ||
    present.apple_music_url === null ||
    present.youtube_music_url === null ||
    present.bandcamp_url === null ||
    present.soundcloud_url === null;
  if (!hasAbsent) return present;

  const fallback = searchUrlProvider.getAllSearchUrls(
    artistName,
    nonBlank(text.album_title)?.trim(),
    nonBlank(text.track_title)?.trim()
  );
  return {
    spotify_url: present.spotify_url ?? fallback.spotifyUrl,
    apple_music_url: present.apple_music_url ?? fallback.appleMusicUrl,
    youtube_music_url: present.youtube_music_url ?? fallback.youtubeMusicUrl,
    bandcamp_url: present.bandcamp_url ?? fallback.bandcampUrl,
    soundcloud_url: present.soundcloud_url ?? fallback.soundcloudUrl,
  };
}
