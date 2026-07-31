/**
 * Proxy controller - thin HTTP layer over existing services.
 *
 * Four of the five handlers route through library-metadata-lookup (LML) for
 * Discogs data and enriched streaming URLs: searchArtwork, getAlbumMetadata,
 * getArtistMetadata, and resolveEntity. The Spotify track handler calls the
 * Spotify API directly (track-by-ID, a different use case from search).
 *
 * All handlers require `requirePermissions({})` + `trackActivity` +
 * `proxyRateLimit` middleware applied at the route level.
 *
 * Every handler that fans out to an upstream (LML or Spotify) sits behind an
 * in-process LRU cache (BS#988, following BS#1089's negative-cache rule): a
 * confirmed absence (a definitive 404 from the upstream) is cached, but a
 * transient failure (timeout/5xx/network) never is — caching a transient
 * failure would strand a degraded response for the full TTL even after the
 * upstream recovers. `searchArtwork`'s `artworkCache`/`negativeCache` pair
 * originated the pattern; `getAlbumMetadata`, `getArtistMetadata`,
 * `resolveEntity`, and `getSpotifyTrack` each declare their own cache
 * immediately above their handler.
 */
import { RequestHandler } from 'express';
import * as Sentry from '@sentry/node';
import { getArtworkFinder } from '../services/artwork/finder.js';
import { classify as classifyNSFW } from '../services/artwork/nsfw.js';
import {
  getRelease,
  getArtistDetails,
  resolveEntity as lmlResolveEntity,
  searchLibrary,
  isSpotifyUrl,
  isAppleMusicUrl,
  LmlClientError,
} from '@wxyc/lml-client';
import type {
  DiscogsMatchResult,
  DiscogsReleaseMetadata,
  DiscogsTrackItem,
  LibrarySearchResponse,
  LookupResponse,
} from '@wxyc/lml-client';
import { lmlLookupCoordinator } from '../services/lml/index.js';
import { getDiscogsReleaseIdByLegacyId, getDiscogsUnavailableFlagsById } from '../services/library.service.js';
import { filterSpacerGif, isSyntheticArtwork } from '../services/metadata/metadata.service.js';
import { SearchUrlProvider } from '../services/metadata/providers/search-urls.provider.js';
import {
  selectLinkedFlowsheetRow,
  lookupAlbumMetadataById,
  lookupCriticReviewsByAlbumId,
  type PersistedAlbumMetadata,
} from '../services/album-metadata-lookup.service.js';
import { getConfig as getCriticReviewsConfig } from '../config/criticReviews.js';
import { LRUCache } from 'lru-cache';
import WxycError from '../utils/error.js';

// Shared instance — stateless, safe to reuse across requests. Centralizes
// fallback-URL synthesis so this controller, the runtime metadata service,
// and the flowsheet-metadata-backfill job all produce identical URLs for
// the same inputs (BS#889).
const searchUrlProvider = new SearchUrlProvider();

// BS#1826 PR 2: `PROXY_LML_BUDGET_MS` retired. `proxy-album-metadata` is a
// class-2 caller (budget 4000ms/timeout 5000ms via the per-caller policy
// layer, `@wxyc/lml-client` `policy.ts`). The old setup passed budgetMs=5000
// with NO explicit timeout, so the socket rode the 30s `TIMEOUT_MS` default
// (budget 5s soft-cut, 30s hard ceiling); the new class-2 default keeps a
// 1s slack between the 4s budget and 5s timeout so a 200-with-fallback can
// flush before the abort. See `docs/env-vars.md` for the retired-constant →
// class mapping.

/** Spotify OAuth2 token response. */
interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface SpotifyTrackApiResponse {
  name: string;
  artists?: Array<{ name: string }>;
  album?: {
    name: string;
    images?: Array<{ url: string }>;
  };
}

// --- Query parameter types ---

type ArtworkSearchQuery = {
  artistName?: string;
  releaseTitle?: string;
};

type AlbumMetadataQuery = {
  artistName?: string;
  releaseTitle?: string;
  trackTitle?: string;
};

type ArtistMetadataQuery = {
  artistId?: string;
};

type EntityResolveQuery = {
  type?: string;
  id?: string;
};

type SpotifyTrackParams = {
  id: string;
};

// --- Image proxy cache ---

/** Cached artwork result: image bytes for SFW results. */
interface CachedArtwork {
  contentType: string;
  data: Buffer;
}

const artworkCache = new LRUCache<string, CachedArtwork>({
  max: 200,
  maxSize: 20 * 1024 * 1024, // 20 MB total
  sizeCalculation: (value) => value.data.byteLength,
  ttl: 1000 * 60 * 60, // 1 hour for positive results
});

/** Separate cache for negative results (NSFW or not found) with longer TTL. */
const negativeCache = new LRUCache<string, boolean>({
  max: 1000,
  ttl: 1000 * 60 * 60 * 24, // 24 hours
});

function artworkCacheKey(artistName: string, releaseTitle?: string): string {
  return `${artistName.toLowerCase().trim()}|${(releaseTitle || '').toLowerCase().trim()}`;
}

// --- Handlers ---

/**
 * GET /proxy/artwork/search
 *
 * Searches for album artwork across Discogs (via LML), Last.fm, and iTunes.
 * Downloads the image, runs NSFW classification, and returns the image bytes
 * directly.
 *
 * Returns 200 with image bytes and Content-Type if SFW artwork is found.
 * Returns 404 if no artwork found or if artwork is NSFW.
 */
export const searchArtwork: RequestHandler<object, unknown, unknown, ArtworkSearchQuery> = async (req, res) => {
  const { artistName, releaseTitle } = req.query;

  if (!artistName) throw new WxycError('artistName query parameter is required', 400);

  const cacheKey = artworkCacheKey(artistName, releaseTitle);

  // Check negative cache first (NSFW or not found)
  if (negativeCache.has(cacheKey)) {
    res.status(404).json({ message: 'No artwork available' });
    return;
  }

  // Check positive cache
  const cached = artworkCache.get(cacheKey);
  if (cached) {
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'private, max-age=600');
    res.status(200).send(cached.data);
    return;
  }

  const finder = getArtworkFinder();
  const result = await finder.find({
    artist: artistName,
    album: releaseTitle || undefined,
  });

  if (!result.artworkUrl) {
    if (result.errored) {
      // BS#1089: every provider that came back empty did so by throwing
      // (LML timeout/5xx/network blip), not by confirming there's no
      // artwork. Skip the negative cache — writing here would strand up to
      // 24h of cold artwork cells per container once LML recovers, since
      // this cache is per-process (see the module doc above). Respond with
      // a retryable upstream failure instead of a false "confirmed no
      // artwork" 404.
      res.status(502).json({ message: 'Artwork lookup temporarily unavailable' });
      return;
    }
    negativeCache.set(cacheKey, true);
    res.status(404).json({ message: 'No artwork found' });
    return;
  }

  // Download the image
  const imageResponse = await fetch(result.artworkUrl);
  if (!imageResponse.ok) {
    console.warn(`[ProxyController] Failed to download artwork from ${result.artworkUrl}: ${imageResponse.status}`);
    negativeCache.set(cacheKey, true);
    res.status(404).json({ message: 'Failed to fetch artwork image' });
    return;
  }

  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';

  // Run NSFW classification
  const nsfwResult = await classifyNSFW(imageBuffer);
  if (nsfwResult === 'nsfw') {
    console.log(`[ProxyController] NSFW artwork blocked for ${artistName} - ${releaseTitle || '(no album)'}`);
    negativeCache.set(cacheKey, true);
    res.status(404).json({ message: 'No artwork available' });
    return;
  }

  // Cache and return the SFW image
  artworkCache.set(cacheKey, { contentType, data: imageBuffer });

  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'private, max-age=600');
  res.status(200).send(imageBuffer);
};

/**
 * Populate metadata fields that come from the lookup response's artwork block
 * — release id/url, artwork URL, artist bio/wiki, streaming URLs. These are
 * present regardless of whether `extended=true` was requested.
 *
 * LML#401 synth shape — see `isSyntheticArtwork()` in metadata.service.ts.
 * Streaming URLs still flow on the synth path; the Discogs identifier
 * fields are skipped so the proxy response doesn't surface `release_id=0`
 * / `release_url=""`.
 */
function populateCommonMetadataFields(metadata: Record<string, unknown>, artwork: DiscogsMatchResult): void {
  if (!isSyntheticArtwork(artwork)) {
    metadata.discogsReleaseId = artwork.release_id;
    metadata.discogsUrl = artwork.release_url;
  }
  // `?? undefined` preserves the original "key omitted in JSON" semantics
  // (the wire contract to iOS); `@wxyc/metadata`'s `filterSpacerGif` returns
  // `null` for falsy/spacer.gif inputs, which would JSON-serialize as
  // `"artworkUrl": null` and break iOS's "missing => draw placeholder" path.
  metadata.artworkUrl = filterSpacerGif(artwork.artwork_url) ?? undefined;

  if (artwork.artist_bio) metadata.artistBio = artwork.artist_bio;
  if (artwork.wikipedia_url) metadata.artistWikipediaUrl = artwork.wikipedia_url;
  if (artwork.artist_image_url) metadata.artistImageUrl = artwork.artist_image_url;
  // Empty `profile_tokens` arrays are truthy in JS; omit the field
  // entirely to match the codebase's "omit when empty" wire convention
  // (cf. `populateReleaseMetadata`'s `genres.length > 0 ? ... : undefined`).
  // Defensive copy: `artwork` may be the coordinator's cached LookupResponse;
  // assigning the array by reference would let any downstream mutation of
  // `metadata.bioTokens` poison the cache.
  if (artwork.profile_tokens && artwork.profile_tokens.length > 0) {
    metadata.bioTokens = [...artwork.profile_tokens];
  }

  if (artwork.spotify_url) metadata.spotifyUrl = artwork.spotify_url;
  if (artwork.apple_music_url) metadata.appleMusicUrl = artwork.apple_music_url;
  if (artwork.youtube_music_url) metadata.youtubeMusicUrl = artwork.youtube_music_url;
  if (artwork.bandcamp_url) metadata.bandcampUrl = artwork.bandcamp_url;
  if (artwork.soundcloud_url) metadata.soundcloudUrl = artwork.soundcloud_url;
}

/**
 * Project an LML `DiscogsTrackItem[]` to the iOS-facing wire shape
 * (`{ position, title, duration }`). Shared by `populateReleaseMetadata`
 * (cold LML-fallthrough) and `buildLocalMetadataResponse` (BS#1331 cache
 * hit, BS#1336) so the two paths emit byte-identical tracklist entries.
 * Returns `undefined` for null/empty input to match the "omit when empty"
 * wire convention. The `.map` produces fresh objects, so the result is
 * always safe to assign without a further defensive copy.
 */
function projectTracklistForWire(tracklist: DiscogsTrackItem[] | null | undefined) {
  if (!tracklist || tracklist.length === 0) return undefined;
  return tracklist.map((t) => ({
    position: t.position,
    title: t.title,
    duration: t.duration ?? undefined,
  }));
}

/**
 * Populate the release-detail fields (tracklist, genres, styles, label,
 * full release date, discogs artist id, release year) from the
 * `DiscogsMatchResult.artwork` block — the coordinator forces `extended:
 * true` on every lookup, so these fields are always present when LML
 * matches a release.
 *
 * Sole caller is `getAlbumMetadata` (the `libraryTracks` path projects
 * tracks via `projectTracks` directly from a `getRelease()` result).
 * The genres/styles/tracklist arrays are defensively copied before
 * being assigned onto `metadata` because the source object can be the
 * coordinator's cached `LookupResponse` — a downstream mutation of
 * `metadata.genres` would otherwise poison the cache for every
 * subsequent same-key reader within the 5-min TTL (cf. the coordinator's
 * read-only contract).
 */
function populateReleaseMetadata(
  metadata: Record<string, unknown>,
  release: {
    year?: number | null;
    genres?: string[] | null;
    styles?: string[] | null;
    label?: string | null;
    artist_id?: number | null;
    released?: string | null;
    tracklist?: DiscogsTrackItem[] | null;
    artwork_url?: string | null;
  }
): void {
  // Discogs returns 0 as "year unknown"; coerce to undefined so it doesn't
  // leak to iOS as a literal "0" on the playcut detail view. Mirrors the
  // chokepoint in `metadata.service.ts#extractAlbumMetadata`. #1002.
  metadata.releaseYear = release.year || undefined;
  metadata.genres = release.genres && release.genres.length > 0 ? [...release.genres] : undefined;
  metadata.styles = release.styles && release.styles.length > 0 ? [...release.styles] : undefined;
  // `|| undefined` (not `?? undefined`) so an empty-string label/date is
  // omitted rather than emitted as `""` — matches the `releaseYear` line above
  // and the local-hit branch's truthy guard (`if (persisted.label)`), so the
  // two branches stay property-for-property equivalent on empty-string input.
  metadata.label = release.label || undefined;
  metadata.discogsArtistId = release.artist_id ?? null;
  metadata.fullReleaseDate = release.released || undefined;
  const tracklist = projectTracklistForWire(release.tracklist);
  if (tracklist) metadata.tracklist = tracklist;
  // Filter spacer.gif placeholders (#649) and surface the artwork URL.
  // On the extended-lookup path this is the same value already set by
  // `populateCommonMetadataFields`; the assignment is idempotent.
  const releaseArtwork = filterSpacerGif(release.artwork_url);
  if (releaseArtwork) metadata.artworkUrl = releaseArtwork;
}

/**
 * Build the proxy-album response from BS's own persisted state.
 *
 * Wire-shape parity with the LML-fallthrough path. As of BS#1336 the
 * eight formerly-LML-only fields (`discogsArtistId`, `genres`, `styles`,
 * `label`, `fullReleaseDate`, `tracklist`, `artistImageUrl`, `bioTokens`)
 * are persisted on `album_metadata` (enrichment-worker, `extended: true`)
 * and emitted here using the same conventions as the LML branch
 * (`populateCommonMetadataFields` + `populateReleaseMetadata`):
 *
 *   - `discogsArtistId` is the one field the LML *match* branch always
 *     emits (`?? null`, key present even when null). To match it
 *     property-for-property, this branch emits it inside the
 *     `discogs_url`-present block — i.e. on match-shaped rows. No-match-
 *     shaped persisted rows (`discogs_url` null — the no-match UPSERT only
 *     writes search URLs) omit it, exactly as the LML no-match branch does.
 *   - the other seven are `|| undefined` / conditional-when-non-empty on the
 *     LML branch and dropped by `JSON.stringify`; this branch omits them
 *     when empty, so the serialized JSON is identical.
 *
 * Two residual divergences are out of scope here and decode-safe: (1) on a
 * synthetic-artwork match (`discogs_url = ''`) the LML branch emits
 * `discogsArtistId: null` while this branch omits it — both falsy, the
 * artist sub-panel renders identically; (2) `artistBio` is the persisted
 * (markup-stripped via `cleanDiscogsBio`) string here vs the raw Discogs
 * markup on the LML branch — a pre-existing write-time-cleaning question
 * tracked separately in BS#1360, not introduced by the BS#1336 field set.
 *
 * dj-site `AlbumDetailPanel` and iOS V1 gate the artist sub-panel on a
 * truthy `discogsArtistId`, so a cache hit now renders the artist subtree
 * without the cold-path LML round-trip. iOS decoders using `decodeIfPresent`
 * (and frontend optional chaining) stay decode-compatible on both branches.
 *
 * `filterSpacerGif` scrubs the Discogs 1×1 placeholder URL on `artworkUrl`
 * just as the LML-fallthrough path does (`populateCommonMetadataFields`).
 * `album_metadata.artwork_url` can carry spacer.gif from the historical
 * `album-metadata-backfill` job (`INSERT … SELECT FROM flowsheet`, no
 * scrub) and from pre-#649 flowsheet rows; if it leaks to iOS, the
 * "missing → placeholder" path on the client breaks.
 *
 * Search-URL synthesis happens at the caller (after this returns) using
 * the same `SearchUrlProvider` chain the LML-fallthrough branch uses, so
 * iOS V1 keeps seeing search-URL fallbacks when a column is null. The
 * BS#1192 "verified rejection" invariant is a *write-path* concern —
 * the catch arm in `enrichment.service.ts` doesn't persist synth URLs
 * — but synthesizing at request time doesn't poison persisted state.
 * The LML-fallthrough branch has always done this for Apple/Spotify
 * and we match it on the local-hit branch for behavioral parity.
 */
function buildLocalMetadataResponse(persisted: PersistedAlbumMetadata): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  // Same filterSpacerGif chokepoint the LML-fallthrough path uses
  // (#649). `album_metadata.artwork_url` is populated by two writers
  // that don't scrub: the runtime enrichment.service path filters at
  // write time, but `album-metadata-backfill` (#898) copied flowsheet
  // rows verbatim, and pre-#649 flowsheet rows persisted the placeholder.
  // The check has to live on read because the historical writes are
  // already on disk.
  const scrubbedArtwork = filterSpacerGif(persisted.artwork_url);
  if (scrubbedArtwork) metadata.artworkUrl = scrubbedArtwork;
  if (persisted.discogs_url) {
    metadata.discogsUrl = persisted.discogs_url;
    const releaseId = parseDiscogsReleaseIdFromUrl(persisted.discogs_url);
    if (releaseId !== undefined) metadata.discogsReleaseId = releaseId;
    // Match the LML match branch's always-present `discogsArtistId` (`?? null`).
    // Gated on `discogs_url` so no-match-shaped rows omit it like the cold path.
    metadata.discogsArtistId = persisted.discogs_artist_id ?? null;
  }
  // Discogs returns 0 as "year unknown"; the write path persists either a
  // real year or null, but check for both shapes defensively (mirrors
  // populateReleaseMetadata + extractAlbumMetadata, #1002).
  if (persisted.release_year) metadata.releaseYear = persisted.release_year;
  // BS#1714: a persisted `spotify_url`/`apple_music_url` mislabeled at the LML
  // boundary before #1712 shipped (e.g. a Deezer URL under `spotify_url`) is
  // suppressed rather than served under the hardwired iOS "Spotify"/"Apple
  // Music" button. Not setting it leaves the L508-509 fallback to synthesize a
  // real `open.spotify.com/search/…` URL — the same degradation the fresh-LML
  // branch already emits.
  if (isSpotifyUrl(persisted.spotify_url)) metadata.spotifyUrl = persisted.spotify_url;
  if (isAppleMusicUrl(persisted.apple_music_url)) metadata.appleMusicUrl = persisted.apple_music_url;
  if (persisted.youtube_music_url) metadata.youtubeMusicUrl = persisted.youtube_music_url;
  if (persisted.bandcamp_url) metadata.bandcampUrl = persisted.bandcamp_url;
  if (persisted.soundcloud_url) metadata.soundcloudUrl = persisted.soundcloud_url;
  if (persisted.artist_bio) metadata.artistBio = persisted.artist_bio;
  if (persisted.artist_wikipedia_url) metadata.artistWikipediaUrl = persisted.artist_wikipedia_url;
  // LML-only enrichment fields (BS#1336). The `[...]` array copies match the
  // LML branch's convention and future-proof the field against a cached
  // lookup layer: `lookupAlbumMetadataById` reads fresh from the DB today (no
  // aliasing hazard), but proxy.controller is cache-heavy and the cache-
  // hierarchy work (project #32) may front this lookup with an LRU — at which
  // point an uncopied array assigned onto the response could be mutated by a
  // downstream caller and poison the shared cache. Copying now keeps that
  // future change safe; the cost is one small-array allocation per cache hit.
  if (persisted.label) metadata.label = persisted.label;
  if (persisted.full_release_date) metadata.fullReleaseDate = persisted.full_release_date;
  if (persisted.genres && persisted.genres.length > 0) metadata.genres = [...persisted.genres];
  if (persisted.styles && persisted.styles.length > 0) metadata.styles = [...persisted.styles];
  const tracklist = projectTracklistForWire(persisted.tracklist);
  if (tracklist) metadata.tracklist = tracklist;
  if (persisted.artist_image_url) metadata.artistImageUrl = persisted.artist_image_url;
  if (persisted.bio_tokens && persisted.bio_tokens.length > 0) metadata.bioTokens = [...persisted.bio_tokens];
  return metadata;
}

/**
 * Extract the Discogs release id from a canonical release URL
 * (`https://www.discogs.com/release/{id}` or
 * `https://www.discogs.com/release/{id}-{slug}`). Returns `undefined`
 * for unparseable URLs so iOS V1 callers that key on `discogsReleaseId`
 * silently degrade to the URL field instead of crashing on a synthetic 0.
 */
function parseDiscogsReleaseIdFromUrl(url: string): number | undefined {
  const match = url.match(/\/release\/(\d+)/);
  if (!match) return undefined;
  const id = parseInt(match[1], 10);
  return Number.isFinite(id) && id > 0 ? id : undefined;
}

// --- Album metadata cache (BS#988) ---
//
// Positive-only server-side memo of the assembled `/proxy/metadata/album`
// enrichment (everything except the request-echoed `artistName`/
// `releaseTitle`/`trackTitle` base fields — see `albumMetadataCacheKey` and
// the write site in the handler below). Keeping the base fields out of the
// cached value means a hit never echoes back a different caller's exact
// request casing; those three are always assembled fresh from the CURRENT
// request, cache hit or miss.
//
// Never written on a transient failure (BS#1089 rule, mirrored here): a
// local DB blip or an LML timeout/5xx/network error leaves the assembled
// response only partially resolved, and caching that degraded shape would
// strand it for the full TTL even after the upstream recovers. Only a
// fully-resolved attempt — a persisted-state hit, or a completed (matched
// or definitively empty) LML round-trip — is cached.

const albumMetadataCache = new LRUCache<string, Record<string, unknown>>({
  max: 2000,
  // BS#1893: bound worst-case memory, not just entry count. An album entry can
  // carry a large `tracklist` (box sets, 100+ tracks) plus `bioTokens`; the
  // count-only cap let a pathological Discogs release balloon this cache
  // unbounded per entry. Mirrors the sibling `artworkCache`'s `maxSize` cap.
  maxSize: 32 * 1024 * 1024, // 32 MB total
  sizeCalculation: (value) => Buffer.byteLength(JSON.stringify(value)) || 1,
  ttl: 1000 * 60 * 60, // 1h (BS#988)
});

/** Test-only: drop cached entries between cases. */
export function __resetAlbumMetadataCacheForTests(): void {
  albumMetadataCache.clear();
}

/** Base fields excluded from the cached value — see the cache's doc comment above. */
const ALBUM_METADATA_BASE_FIELDS = new Set(['artistName', 'releaseTitle', 'trackTitle']);

// BS#1893: `metadata_status` values whose row is still mid-enrichment. A
// `pending` / `enriching` album has no terminal `album_metadata` yet — the CDC
// worker lands enrichment seconds later — so memoizing the point-in-time
// snapshot would strand a stale `metadataStatus` + missing fields for the full
// 1h TTL on this proxy path. The terminal states (`enriched_match`,
// `enriched_no_match`, `failed_no_retry`) are stable and safe to cache.
const NON_TERMINAL_METADATA_STATUSES = new Set(['pending', 'enriching']);

function extractAlbumMetadataEnrichment(metadata: Record<string, unknown>): Record<string, unknown> {
  const enrichment: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!ALBUM_METADATA_BASE_FIELDS.has(key)) enrichment[key] = value;
  }
  return enrichment;
}

/**
 * CRITIC_REVIEWS_ENABLED is the one feature flag that changes this
 * response's shape (adds `criticReviews`) — folded into the key so a flag
 * flip can't serve a stale shape out of the TTL window. Mirrors
 * `trackSearchCacheKey` in `library.service.ts`.
 */
function albumMetadataCacheKey(artistName: string, releaseTitle?: string, trackTitle?: string): string {
  const flagBit = getCriticReviewsConfig().enabled ? '1' : '0';
  const norm = (s?: string) => (s || '').toLowerCase().trim();
  return `${norm(artistName)}|${norm(releaseTitle)}|${norm(trackTitle)}:${flagBit}`;
}

/**
 * GET /proxy/metadata/album
 *
 * Cache-first (BS#1331; server-side response memo BS#988). The handler consults persisted state — the
 * `album_metadata` JOIN to `flowsheet` via the normalized `(artist,
 * album)` lookup key, partial-indexed by `flowsheet_album_link_lookup_idx`
 * — before going to LML. On a local hit it serves what BS already knows,
 * skipping the multi-second `lml.discogs.rate_limiter` queue (the prod
 * trace span dominating the p95 baseline). LML is reached only when no
 * matching `album_id`-bearing flowsheet row exists for the key — the
 * true cold case.
 *
 * On the LML-fallthrough path, the coordinator forces `extended: true`,
 * so LML returns release details (tracklist/genres/styles/label/
 * full_release_date/discogs_artist_id) inline on the top-1 artwork
 * block. One round-trip iOS → BS → LML.
 *
 * `proxy.metadata.album.upstream_calls` Sentry attribute reads 0 on
 * local hit, 1 on cold fallthrough — splittable in the trace explorer
 * so the p50/p95 cohort distinction stays visible.
 *
 * Local-first base fields (BS#1827): `artistName` / `releaseTitle` /
 * `trackTitle` are assembled from the request itself, and `recordLabel` /
 * `labelId` / `metadataStatus` — when a linked flowsheet row is known —
 * come from that SAME row via {@link selectLinkedFlowsheetRow}, which also
 * resolves `albumId`. One query serves both, so the base fields and the
 * `album_id` the persisted-state read below keys off can never describe two
 * different flowsheet rows for one request (a two-query version raced a
 * concurrent flowsheet insert landing between them — fixed in round 2 of
 * this slice). All of this runs BEFORE any LML lookup is attempted below.
 * These are "base": durable BS state, independent of Discogs/LML. Everything
 * else this handler adds afterward (`artworkUrl`, `discogsUrl`, `genres`,
 * `label`, streaming URLs, ...) is "enriched": optional, upstream-dependent,
 * and present only when known. The distinction is implicit in which fields
 * are unconditional vs. conditionally assigned — there's no separate `base`
 * / `enriched` wrapper in the wire shape, and these three new response
 * fields aren't yet in `wxyc-shared/api.yaml` (tracked for the iOS consumer,
 * iOS#685, which also formalizes the `metadata_status`/`isTerminal`
 * contract this sets up — `metadataStatus` here is a faithful echo of the
 * row's column, including any replay staleness; iOS#685 owns that terminal-
 * semantics question, not this handler). The result: an LML timeout can
 * blank `artworkUrl` etc., but it can never blank artist/track/album/label
 * — see the "local-first base fields" test suite for the exact contract.
 */
export const getAlbumMetadata: RequestHandler<object, unknown, unknown, AlbumMetadataQuery> = async (req, res) => {
  const { artistName, releaseTitle, trackTitle } = req.query;

  if (!artistName) throw new WxycError('artistName query parameter is required', 400);

  // Base identity fields (BS#1827): exactly what the caller already asked
  // about, so assembled unconditionally before any lookup or cache check
  // below — nothing that happens next (a DB blip, an LML timeout, a cache
  // hit populated by a differently-cased prior request) can ever erase or
  // relabel these.
  const metadata: Record<string, unknown> = { artistName };
  if (releaseTitle) metadata.releaseTitle = releaseTitle;
  if (trackTitle) metadata.trackTitle = trackTitle;

  // BS#988: server-side cache in front of the persisted-state read + LML
  // round-trip below. A hit short-circuits both entirely — see
  // `albumMetadataCache`'s doc comment above for what is (and isn't) cached.
  const cacheKey = albumMetadataCacheKey(artistName, releaseTitle, trackTitle);
  const cachedEnrichment = albumMetadataCache.get(cacheKey);
  const cacheHit = cachedEnrichment !== undefined;

  let upstreamCalls = 0;
  let albumId: number | null = null;

  if (cacheHit) {
    Object.assign(metadata, cachedEnrichment);
  } else {
    // Cache-first: consult BS's own persisted state before going to LML.
    // Catch-arm-shape rows (YT/BC/SC populated, Apple/Spotify/artwork null)
    // count as hits; the persisted nulls are served, then `searchUrlProvider`
    // fills missing streaming URLs at the bottom of the handler. iOS sees
    // the same shape it would on the LML-fallthrough path.
    //
    // Resolve the linked flowsheet row from the normalized `(artist, album)`
    // lookup key ONCE (BS#1827: album_id plus the base catalog fields, one
    // query), then feed the album_id to both the persisted-metadata read and
    // (below) the critic-reviews read. Resolving per-read would let a
    // flowsheet insert land between the calls and make them describe
    // different albums for the same request.
    //
    // A thrown DB error here would propagate as 500 and regress availability
    // versus the LML-fallthrough path (which catches LML errors and degrades
    // to synthesized search URLs). Treat any DB failure as a cache miss and
    // fall through to LML — the caller's worst-case latency goes up, but the
    // request still completes with a 200. Because album_id and the base
    // fields now come from the SAME query, a failure here can no longer
    // "partially" fail — it drops both together, which is the correct model:
    // there's nothing left to partially succeed at.
    let persisted: PersistedAlbumMetadata | null = null;
    // BS#988: gates the cache write below. A degraded response — a local DB
    // blip or a transient (timeout/5xx/network) LML failure — must never be
    // memoized for the full TTL; mirrors the #1089 rule for the artwork
    // negative cache (only a fully-resolved attempt is cacheable).
    let cacheable = true;
    try {
      const linkedRow = await selectLinkedFlowsheetRow(artistName, releaseTitle);
      albumId = linkedRow?.album_id ?? null;
      // Base catalog fields BS wrote at play time (BS#1827): sourced from the
      // SAME row album_id came from. A free-text row that has never linked to
      // an album_id has no efficient local source for these three (see
      // selectLinkedFlowsheetRow's doc comment) — its artist/release/track
      // identity above still survives via the request echo.
      if (linkedRow?.record_label) metadata.recordLabel = linkedRow.record_label;
      if (linkedRow?.label_id != null) metadata.labelId = linkedRow.label_id;
      if (linkedRow?.metadata_status) metadata.metadataStatus = linkedRow.metadata_status;
      if (albumId !== null) persisted = await lookupAlbumMetadataById(albumId);
    } catch (lookupError) {
      console.warn('[ProxyController] local metadata lookup failed; falling through to LML:', lookupError);
      cacheable = false;
    }

    if (persisted) Object.assign(metadata, buildLocalMetadataResponse(persisted));

    if (!persisted) {
      // Count the LML attempt before awaiting it — counting on success only
      // would conflate the LML-failure cohort with the local-hit cohort on
      // the trace explorer's `upstream_calls=0` split, masking LML incidents
      // as healthy cache-hit growth.
      upstreamCalls += 1;
      let artwork: DiscogsMatchResult | undefined;
      try {
        const lookupResponse: LookupResponse = await lmlLookupCoordinator.lookup(artistName, releaseTitle, trackTitle, {
          caller: 'proxy-album-metadata',
        });
        artwork = lookupResponse.results?.[0]?.artwork;
      } catch (searchError) {
        console.warn('[ProxyController] LML lookup failed:', searchError);
        cacheable = false;
      }

      if (artwork) {
        populateCommonMetadataFields(metadata, artwork);
        populateReleaseMetadata(metadata, {
          year: artwork.release_year,
          genres: artwork.genres,
          styles: artwork.styles,
          label: artwork.label,
          artist_id: artwork.discogs_artist_id,
          released: artwork.full_release_date,
          tracklist: artwork.tracklist,
          artwork_url: artwork.artwork_url,
        });
      }
    }

    // Fallback: construct search URLs for services without persisted/LML URLs.
    // Per-service semantics live in `SearchUrlProvider` (BS#889) — each
    // service uses a different field-fallback order, so the URLs are no
    // longer guaranteed to share a query string. Old behavior was a single
    // combined `${artistName} ${searchTerm}` for all three; the new behavior
    // matches the runtime path and the recurring backfill so iOS gets
    // identical search URLs regardless of which BS path produced them.
    //
    // Post-BS#1185: Spotify and Apple Music also have search-URL fallbacks so
    // iOS doesn't show greyed buttons when LML fails or returns zero results.
    //
    // BS#1192's verified-rejection invariant is a *write-path* concern (don't
    // persist synth URLs in album_metadata). Synthesizing at request time
    // doesn't poison persisted state, and both the local-hit and LML
    // branches synthesize here so iOS sees identical degradation behavior
    // regardless of which branch served the request.
    const fallbackUrls = searchUrlProvider.getAllSearchUrls(artistName, releaseTitle, trackTitle);
    if (!metadata.spotifyUrl) metadata.spotifyUrl = fallbackUrls.spotifyUrl;
    if (!metadata.appleMusicUrl) metadata.appleMusicUrl = fallbackUrls.appleMusicUrl;
    if (!metadata.youtubeMusicUrl) metadata.youtubeMusicUrl = fallbackUrls.youtubeMusicUrl;
    if (!metadata.bandcampUrl) metadata.bandcampUrl = fallbackUrls.bandcampUrl;
    if (!metadata.soundcloudUrl) metadata.soundcloudUrl = fallbackUrls.soundcloudUrl;

    // External critic-review snippets (album-critic-reviews slice, ADR 0012).
    // Flag-gated (`CRITIC_REVIEWS_ENABLED`, default off) so prod behavior — the
    // response shape and the serve-path query plan — is unchanged until an
    // operator opts in, keeping this compatible with the #32 hardening freeze
    // on the album-metadata serve path. Reuses the `album_id` resolved for the
    // metadata read above (one extra indexed read, not a second key resolve),
    // and runs whenever the key resolved to a linked album — independent of
    // whether `album_metadata` enrichment has landed, so a linked album with
    // reviews but no metadata row still surfaces its reviews. Attached only when
    // non-empty so an un-seeded album's response is byte-identical to before.
    // Wrapped in try/catch: the reviews read is strictly additive and must never
    // break the metadata response, so a DB failure degrades to omitting the field.
    if (getCriticReviewsConfig().enabled && albumId !== null) {
      try {
        const criticReviews = await lookupCriticReviewsByAlbumId(albumId);
        if (criticReviews.length > 0) metadata.criticReviews = criticReviews;
      } catch (reviewsError) {
        console.warn('[ProxyController] critic-reviews lookup failed; omitting criticReviews:', reviewsError);
        cacheable = false;
      }
    }

    // BS#1895 (Not-on-Discogs epic #1280 sub-issue 5): iOS reads this
    // handler for the playcut-detail metadata behind the artwork/detail
    // panel, so the MD-set flag needs to reach it too — otherwise a flagged
    // release keeps showing the "missing artwork" empty state instead of the
    // "not on Discogs" messaging. `discogs_unavailable` lives on `library`,
    // not `album_metadata` (this handler's usual source) or `flowsheet`, so
    // it's a dedicated lookup keyed on the SAME `albumId` resolved above
    // rather than a join into either persisted-state read. Reuses the same
    // gate as critic reviews (`albumId !== null` — a free-text row that never
    // linked to a catalog album has no library row to flag) and the same
    // additive-failure contract: a DB blip degrades to omitting the field
    // rather than failing the request.
    if (albumId !== null) {
      try {
        const discogsFlags = await getDiscogsUnavailableFlagsById(albumId);
        if (discogsFlags) {
          metadata.discogsUnavailable = discogsFlags.discogsUnavailable;
          if (discogsFlags.discogsUnavailableNote !== null) {
            metadata.discogsUnavailableNote = discogsFlags.discogsUnavailableNote;
          }
          if (discogsFlags.lastDiscogsRecheckAt !== null) {
            metadata.lastDiscogsRecheckAt = discogsFlags.lastDiscogsRecheckAt;
          }
        }
      } catch (discogsFlagsError) {
        console.warn(
          '[ProxyController] discogs-unavailable lookup failed; omitting discogsUnavailable:',
          discogsFlagsError
        );
        cacheable = false;
      }
    }

    // BS#1893: never memoize a non-terminal (pending/enriching) snapshot. Its
    // enrichment lands seconds later via the CDC worker, and a 1h-cached pending
    // snapshot would mask that freshness on this path until the TTL expires.
    if (typeof metadata.metadataStatus === 'string' && NON_TERMINAL_METADATA_STATUSES.has(metadata.metadataStatus)) {
      cacheable = false;
    }

    if (cacheable) {
      albumMetadataCache.set(cacheKey, extractAlbumMetadataEnrichment(metadata));
    }
  }

  // Project the upstream-call count + cache result onto the active Sentry
  // span so we can split p50/p95 by cohort in the trace explorer. Wrap in
  // try/except — observability must never break the request path. Two
  // separate calls (not one merged object) so each attribute name is
  // independently greppable in the trace explorer.
  try {
    Sentry.getActiveSpan()?.setAttributes({
      'proxy.metadata.album.upstream_calls': upstreamCalls,
    });
    Sentry.getActiveSpan()?.setAttributes({
      'proxy.metadata.album.cache_hit': cacheHit,
    });
  } catch (err) {
    console.warn('[ProxyController] failed to project Sentry attrs', err);
  }

  res.set('Cache-Control', 'private, max-age=600');
  res.status(200).json(metadata);
};

// --- Artist metadata cache (BS#988) ---
//
// Single cache holding either the assembled response body (a hit) or `body:
// null` (a confirmed absence — LML resolved the id and definitively found
// no artist). The `{ body }` wrapper is required because `LRUCache`'s value
// type must extend `{}` — a bare `Record<string, unknown> | null` value
// type doesn't typecheck, since `null` isn't assignable to `{}`. Mirrors
// `tracklistCache`/`libraryTracks`'s shape below: a transient failure
// (timeout/5xx/network — anything but a 404) is never written here, only
// rethrown, so a repeat request keeps retrying LML for the rest of the TTL
// (BS#1089 rule).

const artistMetadataCache = new LRUCache<number, { body: Record<string, unknown> | null }>({
  max: 2000,
  ttl: 1000 * 60 * 60, // 1h (BS#988)
});

/** Test-only: drop cached entries between cases. */
export function __resetArtistMetadataCacheForTests(): void {
  artistMetadataCache.clear();
}

/**
 * GET /proxy/metadata/artist
 *
 * Fetches artist metadata (bio, Wikipedia URL, image) from LML by artist ID.
 * Bio is available as both raw Discogs markup (`bio`) and pre-parsed structured
 * tokens (`bioTokens`) for direct rendering by clients.
 *
 * Cache-first (BS#988): a hit (positive or confirmed-negative) short-circuits
 * before any LML call.
 */
export const getArtistMetadata: RequestHandler<object, unknown, unknown, ArtistMetadataQuery> = async (req, res) => {
  const { artistId } = req.query;

  if (!artistId) throw new WxycError('artistId query parameter is required', 400);

  const id = parseInt(artistId, 10);
  if (isNaN(id)) throw new WxycError('artistId must be an integer', 400);

  let cacheHit = true;
  let cached = artistMetadataCache.get(id);

  if (cached === undefined) {
    cacheHit = false;
    try {
      const artist = await getArtistDetails(id);
      const wikipediaUrl = artist.urls.find((url) => url.includes('wikipedia.org')) ?? null;
      cached = {
        body: {
          discogsArtistId: artist.artist_id,
          bio: artist.profile ?? null,
          bioTokens: artist.profile_tokens ?? null,
          wikipediaUrl,
          imageUrl: artist.image_url ?? null,
        },
      };
      artistMetadataCache.set(id, cached);
    } catch (err) {
      if (err instanceof LmlClientError && err.statusCode === 404) {
        // BS#988: confirmed absence — cache the negative so a repeat
        // request for the same id doesn't re-hit LML for the rest of the
        // TTL. Any other status (502/504/...) is a transient failure and
        // is deliberately NOT cached — the original error still propagates
        // below so the response shape on a miss is unchanged.
        artistMetadataCache.set(id, { body: null });
      }
      throw err;
    }
  }

  try {
    Sentry.getActiveSpan()?.setAttributes({ 'proxy.metadata.artist.cache_hit': cacheHit });
  } catch (err) {
    console.warn('[ProxyController] failed to project Sentry attrs', err);
  }

  if (cached.body === null) {
    // Cache hit on a confirmed absence recorded by a prior miss above.
    throw new WxycError('Artist not found', 404);
  }

  res.set('Cache-Control', 'private, max-age=3600');
  res.status(200).json(cached.body);
};

// --- Entity resolve cache (BS#988) ---
//
// Same `{ body }`-wrapped shape as `artistMetadataCache` above (required
// because `LRUCache`'s value type must extend `{}`, so a bare nullable
// value type doesn't typecheck): the cached value is either the response
// body (a hit) or `body: null` (a confirmed absence — LML resolved type+id
// and definitively found nothing). A transient failure is never cached,
// only rethrown (BS#1089 rule). 24h TTL matches the client Cache-Control
// max-age already set below — resolved Discogs entity identities are
// effectively immutable once minted.

const entityResolveCache = new LRUCache<string, { body: Record<string, unknown> | null }>({
  max: 2000,
  ttl: 1000 * 60 * 60 * 24, // 24h (BS#988) — positive resolutions are immutable
});

// BS#1893: a confirmed 404 is negative-cached, but LML resolves entities out of
// its discogs-cache, which has known transient-404 windows during rebuilds (the
// discogs-cache-rebuild <-> LML race). Decouple the negative TTL from the 24h
// positive one so a rebuild-transient absence self-corrects in minutes instead
// of pinning "not found" per container for a full day. Mirrors the sibling
// `tracklistCache`'s 10-min 404 memo.
const ENTITY_RESOLVE_NEGATIVE_TTL_MS = 1000 * 60 * 10; // 10 min

/** Test-only: drop cached entries between cases. */
export function __resetEntityResolveCacheForTests(): void {
  entityResolveCache.clear();
}

/** Test-only: remaining TTL (ms) for a cached entity-resolve entry. */
export function __getEntityResolveRemainingTtlForTests(type: string, id: number): number {
  return entityResolveCache.getRemainingTTL(entityResolveCacheKey(type, id));
}

function entityResolveCacheKey(type: string, id: number): string {
  return `${type}:${id}`;
}

/**
 * GET /proxy/entity/resolve
 *
 * Resolves a Discogs entity (artist, release, master) by type and ID via LML.
 * Returns the entity's name and basic info.
 *
 * Cache-first (BS#988): a hit (positive or confirmed-negative) short-circuits
 * before any LML call.
 */
export const resolveEntity: RequestHandler<object, unknown, unknown, EntityResolveQuery> = async (req, res) => {
  const { type, id } = req.query;

  if (!type || !id) throw new WxycError('type and id query parameters are required', 400);

  const validTypes = ['artist', 'release', 'master'] as const;
  if (!validTypes.includes(type as (typeof validTypes)[number])) {
    throw new WxycError(`type must be one of: ${validTypes.join(', ')}`, 400);
  }

  const entityId = parseInt(id, 10);
  if (isNaN(entityId)) throw new WxycError('id must be an integer', 400);

  const cacheKey = entityResolveCacheKey(type, entityId);
  let cacheHit = true;
  let cached = entityResolveCache.get(cacheKey);

  if (cached === undefined) {
    cacheHit = false;
    try {
      const result = await lmlResolveEntity(type as 'artist' | 'release' | 'master', entityId);
      cached = { body: { name: result.name, type: result.type, id: result.id } };
      entityResolveCache.set(cacheKey, cached);
    } catch (err) {
      if (err instanceof LmlClientError && err.statusCode === 404) {
        // BS#988: confirmed absence — cache the negative so a repeat
        // request for the same type+id doesn't re-hit LML for the rest of
        // the TTL. Any other status is a transient failure and is
        // deliberately NOT cached; the original error still propagates.
        // BS#1893: give the 404 a short TTL (not the 24h positive default) so a
        // discogs-cache-rebuild-transient absence self-corrects quickly.
        entityResolveCache.set(cacheKey, { body: null }, { ttl: ENTITY_RESOLVE_NEGATIVE_TTL_MS });
      }
      throw err;
    }
  }

  try {
    Sentry.getActiveSpan()?.setAttributes({ 'proxy.entity.resolve.cache_hit': cacheHit });
  } catch (err) {
    console.warn('[ProxyController] failed to project Sentry attrs', err);
  }

  if (cached.body === null) {
    // Cache hit on a confirmed absence recorded by a prior miss above.
    throw new WxycError('Entity not found', 404);
  }

  res.set('Cache-Control', 'private, max-age=86400');
  res.status(200).json(cached.body);
};

// --- Spotify track cache (BS#988) ---
//
// Same `{ body }`-wrapped shape as `artistMetadataCache`/`entityResolveCache`
// above (required because `LRUCache`'s value type must extend `{}`): the
// cached value is either the response body (a hit) or `body: null` (a
// confirmed absence — Spotify returned a definitive 404 for the track id).
// A transient failure (token/auth failure, non-404 fetch failure) is never
// cached (BS#1089 rule), and neither is the "Spotify isn't configured at
// all" 503 — that's an environment-wide condition, not a per-track fact.

const spotifyTrackCache = new LRUCache<string, { body: Record<string, unknown> | null }>({
  max: 2000,
  ttl: 1000 * 60 * 60, // 1h (BS#988) — same tier as album/artist metadata.
});

/** Test-only: drop cached entries between cases. */
export function __resetSpotifyTrackCacheForTests(): void {
  spotifyTrackCache.clear();
}

/**
 * GET /proxy/spotify/track/:id
 *
 * Fetches Spotify track metadata using backend credentials.
 *
 * Cache-first (BS#988): a hit (positive or confirmed-negative) short-circuits
 * before any Spotify call (token fetch included).
 */
export const getSpotifyTrack: RequestHandler<SpotifyTrackParams> = async (req, res) => {
  const { id } = req.params;

  if (!id) throw new WxycError('Track ID is required', 400);

  let cacheHit = true;
  let cached = spotifyTrackCache.get(id);

  if (cached === undefined) {
    cacheHit = false;

    // Use the SpotifyProvider's internal auth to call the Spotify API
    const spotifyClientId = process.env.SPOTIFY_CLIENT_ID;
    const spotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!spotifyClientId || !spotifyClientSecret) {
      res.status(503).json({ message: 'Spotify integration not configured' });
      return;
    }

    // Get or refresh Spotify access token
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${spotifyClientId}:${spotifyClientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!tokenResponse.ok) {
      console.error(`[ProxyController] Spotify auth failed: ${tokenResponse.status}`);
      res.status(502).json({ message: 'Spotify authentication failed' });
      return;
    }

    const tokenData: SpotifyTokenResponse = (await tokenResponse.json()) as SpotifyTokenResponse;

    const trackResponse = await fetch(`https://api.spotify.com/v1/tracks/${encodeURIComponent(id)}`, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    if (!trackResponse.ok) {
      if (trackResponse.status === 404) {
        // BS#988: confirmed absence — cache the negative so a repeat
        // request for the same id doesn't re-hit Spotify for the rest of
        // the TTL.
        spotifyTrackCache.set(id, { body: null });
        res.status(404).json({ message: 'Track not found' });
        return;
      }
      console.error(`[ProxyController] Spotify track fetch failed: ${trackResponse.status}`);
      res.status(502).json({ message: 'Failed to fetch track from Spotify' });
      return;
    }

    const track: SpotifyTrackApiResponse = (await trackResponse.json()) as SpotifyTrackApiResponse;
    cached = {
      body: {
        title: track.name,
        artist: track.artists?.[0]?.name || '',
        album: track.album?.name || '',
        artworkUrl: track.album?.images?.[0]?.url || null,
      },
    };
    spotifyTrackCache.set(id, cached);
  }

  try {
    Sentry.getActiveSpan()?.setAttributes({ 'proxy.spotify.track.cache_hit': cacheHit });
  } catch (err) {
    console.warn('[ProxyController] failed to project Sentry attrs', err);
  }

  if (cached.body === null) {
    // Cache hit on a confirmed absence recorded by a prior miss above.
    res.status(404).json({ message: 'Track not found' });
    return;
  }

  res.set('Cache-Control', 'private, max-age=600');
  res.status(200).json(cached.body);
};

/**
 * GET /proxy/library/search -- Search the WXYC library catalog via LML.
 *
 * Proxies to LML's GET /api/v1/library/search, providing auth, rate limiting,
 * and activity tracking. Used by dj-site for flowsheet autocomplete.
 *
 * Query params: artist, title, q (free text), limit (default 10)
 */
type LibrarySearchQuery = {
  artist?: string;
  title?: string;
  q?: string;
  limit?: string;
};

export const librarySearch: RequestHandler<object, unknown, unknown, LibrarySearchQuery> = async (req, res) => {
  const { artist, title, q, limit } = req.query;

  if (!artist && !title && !q) throw new WxycError('At least one of artist, title, or q is required', 400);

  let results: LibrarySearchResponse;
  try {
    results = await searchLibrary({
      artist,
      title,
      q,
      limit: limit ? parseInt(limit, 10) : undefined,
      // BS#1826 PR 2: the PRD's protected-search win — class 1 (3s timeout,
      // no budget header), so local catalog search can't be starved by
      // enrichment/batch LML traffic sharing the same default.
      caller: 'proxy-library-search',
    });
  } catch (err) {
    // BS#1826 / PRD #1819: class 1's contract is "never surface a 5xx —
    // degrade to empty results." The class-1 timeout is deliberately short
    // (3s), so a slow/overloaded LML must NOT turn dj-site catalog
    // autocomplete into an error toast — an LML timeout/abort/transport
    // failure returns an empty result set (BS holds no local mirror of LML's
    // SQLite catalog, so "local/empty" is empty here). Only re-throw a
    // non-LML programming error so genuine bugs still surface.
    if (!(err instanceof LmlClientError)) throw err;
    Sentry.getActiveSpan()?.setAttributes({ 'proxy.library_search.degraded': true });
    console.warn(`[ProxyController] library search degraded to empty (LML ${err.statusCode ?? 'error'})`, err.message);
    results = { results: [], total: 0, query: q ?? null };
  }

  res.set('Cache-Control', 'private, max-age=60');
  res.status(200).json(results);
};

/**
 * GET /proxy/library/:libraryId/tracks (E6-5 / BS#836)
 *
 * Returns the tracklist for a library release so the dj-site flowsheet
 * picker can let DJs pick a track by position after selecting a release
 * (catalog-track-search plan §4.3 / Track 3).
 *
 * Composition (BS-side; no new LML endpoint):
 *   1. Map inbound `libraryId` (LML `library.db.id` = BS `library.legacy_release_id`)
 *      → resolved Discogs release id via `library_identity`.
 *   2. Fetch the tracklist from LML's `GET /api/v1/discogs/release/{id}`.
 *
 * Degrades gracefully — when no identity is resolved (typical for rows
 * BS#802's backfill hasn't covered yet) or LML returns 404 on the release,
 * the response is 200 with `tracks: []` and the picker falls back to
 * free-text input. Only LML 5xx errors bubble up to the error handler.
 *
 * Each hit is cached BS-side by Discogs release id for 10 minutes — a thin
 * deduplication layer on top of LML's own 3-tier cache.
 */
interface LibraryTrackEntry {
  position: string;
  title: string;
  artist_credit: string;
  duration_ms: number | null;
}

interface LibraryTracksResponse {
  library_id: number;
  discogs_release_id: number | null;
  source: 'discogs' | null;
  tracks: LibraryTrackEntry[];
}

const tracklistCache = new LRUCache<number, LibraryTrackEntry[]>({
  max: 500,
  ttl: 1000 * 60 * 10,
});

/** Test-only: drop cached entries between cases. */
export function __resetLibraryTracksCacheForTests(): void {
  tracklistCache.clear();
}

/**
 * Parse a Discogs `duration` string ("M:SS", "H:MM:SS", or bare seconds)
 * into milliseconds. Returns null for empty or unparseable values — Discogs
 * sometimes leaves the field blank or stores freeform text.
 */
function parseDurationMs(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const parts = raw.split(':').map((p) => p.trim());
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  let seconds: number;
  if (nums.length === 1) seconds = nums[0];
  else if (nums.length === 2) seconds = nums[0] * 60 + nums[1];
  else if (nums.length === 3) seconds = nums[0] * 3600 + nums[1] * 60 + nums[2];
  else return null;
  return seconds * 1000;
}

function buildArtistCredit(track: DiscogsTrackItem, releaseArtist: string): string {
  if (track.artists && track.artists.length > 0) return track.artists.join(', ');
  return releaseArtist;
}

function projectTracks(release: DiscogsReleaseMetadata): LibraryTrackEntry[] {
  return release.tracklist.map((t) => ({
    position: t.position,
    title: t.title,
    artist_credit: buildArtistCredit(t, release.artist),
    duration_ms: parseDurationMs(t.duration),
  }));
}

export const libraryTracks: RequestHandler<{ libraryId: string }> = async (req, res) => {
  const libraryId = parseInt(req.params.libraryId, 10);
  if (!Number.isInteger(libraryId) || libraryId <= 0) {
    throw new WxycError('libraryId must be a positive integer', 400);
  }

  const discogsReleaseId = await getDiscogsReleaseIdByLegacyId(libraryId);
  if (discogsReleaseId === null) {
    const body: LibraryTracksResponse = {
      library_id: libraryId,
      discogs_release_id: null,
      source: null,
      tracks: [],
    };
    res.set('Cache-Control', 'private, max-age=600');
    res.status(200).json(body);
    return;
  }

  let tracks = tracklistCache.get(discogsReleaseId);
  if (!tracks) {
    try {
      const release = await getRelease(discogsReleaseId);
      tracks = projectTracks(release);
    } catch (err) {
      if (err instanceof LmlClientError && err.statusCode === 404) {
        // Cache the empty result so repeat requests for a release LML
        // doesn't know about don't re-hit LML for 10 minutes.
        tracks = [];
      } else {
        throw err;
      }
    }
    tracklistCache.set(discogsReleaseId, tracks);
  }

  const body: LibraryTracksResponse = {
    library_id: libraryId,
    discogs_release_id: discogsReleaseId,
    source: 'discogs',
    tracks,
  };
  res.set('Cache-Control', 'private, max-age=600');
  res.status(200).json(body);
};
