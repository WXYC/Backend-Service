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
 * least one streaming URL the client would actually see. The gate uses
 * {@link wireUrl}, the wire's own presence predicate, so the gate bit and iOS
 * 3.2's `inline.streaming.hasAny` are the same bit by construction. See that
 * function for why the gate exists.
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

/**
 * True iff `value` contains a character that makes `new URL()`'s verdict a
 * statement about a DIFFERENT string than the one we are about to emit.
 *
 * `wireUrl` validates with the WHATWG parser but emits the original text, so
 * every place the two disagree is a parser differential the wire inherits:
 *
 *   - **Backslash.** For the http(s) special schemes WHATWG folds `\` to `/`,
 *     so `new URL('https://www.discogs.com\\@evil.example/release/1')` reports
 *     hostname `www.discogs.com`. Foundation/RFC 3986 do NOT fold it, so the
 *     same bytes resolve to host `evil.example` on iOS. This is the identical
 *     differential `shared/lml-client/src/streaming-url-guard.ts`'s
 *     `safeHostname` opens with `if (url.includes('\\')) return null` (BS#1710);
 *     same reasoning, same verdict, at this seam.
 *   - **ASCII whitespace and control characters.** WHATWG *strips* raw tab, LF
 *     and CR anywhere in the input and percent-encodes other C0 characters and
 *     the space before parsing, so `'https://e.com/a\tb'` validates as
 *     `https://e.com/ab` — a URL that is not what we would emit. `.trim()`
 *     only reaches the ends. Foundation rejects the raw form, which is the
 *     throwing decode this whole helper exists to avoid.
 */
export function hasWireUrlParserDifferential(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // C0 controls + space (<= 0x20), DEL (0x7f), backslash (0x5c).
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * Normalize a persisted URL for the wire, or `undefined` to omit the key.
 *
 * iOS decodes every URL-typed playcut field with
 * `try container.decodeIfPresent(URL.self, forKey:)`. That is *throwing*, not
 * tolerant: a present-but-unparseable value raises `DecodingError` and fails
 * the whole `Playcut` decode, which empties the playlist for that listener.
 * `/flowsheet` passes these through raw because its consumer decodes them as
 * strings, so only the legacy `?v=2` seam uses this as an OUTPUT filter. Both
 * seams use it as a PREDICATE, though — `fillSynthesizedSearchUrls` asks it
 * whether a persisted streaming URL exists for the client at all (#2339).
 *
 * Only an absolute `http`/`https` URL survives. Everything else — `''`,
 * whitespace, a relative path, a bare hostname, a scheme-relative `//host/...`,
 * a non-web scheme — is dropped rather than risked. Dropping a field costs one
 * missing button; emitting a bad one costs the whole playlist.
 *
 * REJECT, don't normalize. The emitted value is the trimmed ORIGINAL, never
 * `parsed.href`, so anything `new URL()` silently rewrites while parsing is a
 * differential between what was validated and what ships — see
 * {@link hasWireUrlParserDifferential}, which rejects those inputs outright.
 * Emitting `parsed.href` instead would close the same differentials, but it
 * would also percent-encode the ~21 production values carrying raw non-ASCII in
 * the path (`https://en.wikipedia.org/wiki/Nilüfer_Yanya` -> `…/Nil%C3%BCfer_…`),
 * which ship verbatim today and decode fine on iOS. Rejecting touches only the
 * hazardous inputs, leaves every good byte alone, and matches the repo's
 * existing precedent at the LML boundary (BS#1710).
 */
export function wireUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (hasWireUrlParserDifferential(trimmed)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (parsed.hostname === '') return undefined;
  return trimmed;
}

const searchUrlProvider = new SearchUrlProvider();

/**
 * A persisted streaming URL that will actually reach a client, or `null`.
 *
 * The test is {@link wireUrl}'s — absolute http(s), no parser differential —
 * NOT merely "non-blank". Anything else (`''`, whitespace, a bare hostname, a
 * scheme-relative `//host/…`, `javascript:`, a raw-tab/LF/backslash
 * differential) is ABSENT for both of {@link fillSynthesizedSearchUrls}'s
 * purposes: it does not qualify a row for the fill, and on a row that does
 * qualify it degrades to a synthesized URL instead of surviving to be dropped
 * downstream with no fallback left to run.
 *
 * Using the wire's own predicate is what makes the gate sound. The proxy's
 * fallback arms are falsy checks (`if (!metadata.spotifyUrl) …`) rather than
 * `??`-nullish ones, so this is the same degradation shape, evaluated against
 * the same question the client asks: is there a link here or not.
 *
 * The original value is returned, not `wireUrl`'s trimmed copy — trimming is
 * the legacy seam's output concern, and the `/flowsheet` seam has always
 * emitted persisted text verbatim.
 */
function wireablePersistedUrl(value: string | null): string | null {
  return wireUrl(value) === undefined ? null : value;
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
 *   1. **At least one streaming URL that would reach the client** (owner
 *      decision, 2026-08-31, on #2339). Shipped iOS 3.2's
 *      `PlaycutMetadataService` skips the live `/proxy/metadata/album` fetch
 *      when `metadataStatus?.isTerminal == true || inline.streaming.hasAny`. A
 *      row that already carries a real streaming URL short-circuits inline
 *      REGARDLESS of what we do, so filling it only upgrades grey
 *      Spotify/Apple buttons and can never suppress a fetch. A row with no such
 *      URL must keep serving NULLs: filling it would satisfy
 *      `streaming.hasAny` and suppress the live proxy fallback — which returns
 *      full metadata AND synthesizes its own links — leaving the user a card
 *      with five search buttons and nothing else, permanently. That is
 *      BS#2103's empty-card bug, reopened. The post-#2295-drain cohort (the
 *      population this ticket exists for) qualifies: the drain persisted
 *      synthesized YouTube Music / Bandcamp / SoundCloud URLs on every matched
 *      row.
 *
 *      "Would reach the client" is {@link wireablePersistedUrl}, i.e.
 *      {@link wireUrl}'s own predicate — so `carriesWireableStreamingUrl` and
 *      the client's `streaming.hasAny` are the same bit by construction, and
 *      the gate cannot be flipped by a value the wire is about to drop. The
 *      gate is this one shared function at both seams; only the OUTPUT filters
 *      differ per seam (the legacy `?v=2` payload runs `wireUrl` again on the
 *      way out; `/flowsheet` emits verbatim).
 *
 *      A row whose ONLY streaming URL was suppressed by the host guard counts
 *      as zero-streaming and serves NULLs — the proxy fallback then both
 *      fetches and synthesizes, consistent with #1714's degradation.
 *
 *   2. **A non-blank `artist_name`** — there is nothing to search on without
 *      one, and a whitespace-only name would synthesize five buttons opening
 *      `%20%20%20` searches. A marker/talkset/breakpoint row (or a track row
 *      that somehow lost its artist name) degrades to nulls exactly as before.
 *
 * A persisted value that fails the wire predicate is normalized to `null`
 * unconditionally, whether or not the row qualifies for the fill, so a blank
 * can never reach a wire as `""` and an unusable one can never reach a
 * hardwired iOS button.
 */
export function fillSynthesizedSearchUrls(
  urls: SynthesizableStreamingUrls,
  text: { artist_name: string | null; album_title: string | null; track_title: string | null }
): SynthesizableStreamingUrls {
  const present: SynthesizableStreamingUrls = {
    spotify_url: wireablePersistedUrl(urls.spotify_url),
    apple_music_url: wireablePersistedUrl(urls.apple_music_url),
    youtube_music_url: wireablePersistedUrl(urls.youtube_music_url),
    bandcamp_url: wireablePersistedUrl(urls.bandcamp_url),
    soundcloud_url: wireablePersistedUrl(urls.soundcloud_url),
  };

  // Gate 1: nothing the client would see -> serve NULLs, keep the 3.2 proxy fallback.
  const carriesWireableStreamingUrl =
    present.spotify_url !== null ||
    present.apple_music_url !== null ||
    present.youtube_music_url !== null ||
    present.bandcamp_url !== null ||
    present.soundcloud_url !== null;
  if (!carriesWireableStreamingUrl) return present;

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

  const albumTitle = text.album_title?.trim();
  const trackTitle = text.track_title?.trim();
  const fallback = searchUrlProvider.getAllSearchUrls(artistName, albumTitle || undefined, trackTitle || undefined);
  return {
    spotify_url: present.spotify_url ?? fallback.spotifyUrl,
    apple_music_url: present.apple_music_url ?? fallback.appleMusicUrl,
    youtube_music_url: present.youtube_music_url ?? fallback.youtubeMusicUrl,
    bandcamp_url: present.bandcamp_url ?? fallback.bandcampUrl,
    soundcloud_url: present.soundcloud_url ?? fallback.soundcloudUrl,
  };
}
