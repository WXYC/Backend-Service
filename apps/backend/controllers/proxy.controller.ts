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
  envInt,
  LmlClientError,
} from '@wxyc/lml-client';
import type { DiscogsMatchResult, DiscogsReleaseMetadata, DiscogsTrackItem, LookupResponse } from '@wxyc/lml-client';
import { lmlLookupCoordinator } from '../services/lml/index.js';
import { getDiscogsReleaseIdByLegacyId } from '../services/library.service.js';
import { filterSpacerGif, isSyntheticArtwork } from '../services/metadata/metadata.service.js';
import { SearchUrlProvider } from '../services/metadata/providers/search-urls.provider.js';
import { lookupAlbumMetadataByKey, type PersistedAlbumMetadata } from '../services/album-metadata-lookup.service.js';
import { LRUCache } from 'lru-cache';
import WxycError from '../utils/error.js';

// Shared instance — stateless, safe to reuse across requests. Centralizes
// fallback-URL synthesis so this controller, the runtime metadata service,
// and the flowsheet-metadata-backfill job all produce identical URLs for
// the same inputs (BS#889).
const searchUrlProvider = new SearchUrlProvider();

/**
 * Budget for the user-visible iOS playlist + dj-site cover-art path. Tight
 * because the controller would rather degrade to synthesized fallback URLs
 * than hold the response on an obscure-artist cascade. Matches the 5 s
 * deadline used by the rotation picker (BS#992). See `LookupOptions.budgetMs`
 * for the mechanics.
 */
const PROXY_LML_BUDGET_MS = envInt('PROXY_LML_BUDGET_MS', 5000);

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
  metadata.label = release.label ?? undefined;
  metadata.discogsArtistId = release.artist_id ?? null;
  metadata.fullReleaseDate = release.released ?? undefined;
  if (release.tracklist && release.tracklist.length > 0) {
    metadata.tracklist = release.tracklist.map((t) => ({
      position: t.position,
      title: t.title,
      duration: t.duration ?? undefined,
    }));
  }
  // Filter spacer.gif placeholders (#649) and surface the artwork URL.
  // On the extended-lookup path this is the same value already set by
  // `populateCommonMetadataFields`; the assignment is idempotent.
  const releaseArtwork = filterSpacerGif(release.artwork_url);
  if (releaseArtwork) metadata.artworkUrl = releaseArtwork;
}

/**
 * Build the proxy-album response from BS's own persisted state.
 *
 * Wire-shape parity with the LML-fallthrough path is *almost* but not
 * exact. Eight LML-only fields aren't on `album_metadata`:
 * `discogsArtistId`, `genres`, `styles`, `label`, `fullReleaseDate`,
 * `tracklist`, `artistImageUrl`, `bioTokens`. Seven of those are
 * assigned `?? undefined` / `|| undefined` / conditional-when-non-empty
 * on the LML branch and dropped by `JSON.stringify`, so the wire output
 * is the same as this branch's "key omitted" shape. The one real
 * divergence is `discogsArtistId`, which the LML branch assigns as
 * `?? null` (always present, sometimes literal `null`) and this branch
 * omits entirely. iOS V1 and dj-site `AlbumDetailPanel` gate the
 * artist sub-panel on a truthy `discogsArtistId`, so cache-hit cohorts
 * silently lose the artist subtree until #1336 extends the
 * `album_metadata` schema to carry the LML-only enrichment fields.
 *
 * iOS decoders that use `decodeIfPresent` (and frontend code that
 * uses optional chaining) see a decode-compatible shape on both
 * branches.
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
  }
  // Discogs returns 0 as "year unknown"; the write path persists either a
  // real year or null, but check for both shapes defensively (mirrors
  // populateReleaseMetadata + extractAlbumMetadata, #1002).
  if (persisted.release_year) metadata.releaseYear = persisted.release_year;
  if (persisted.spotify_url) metadata.spotifyUrl = persisted.spotify_url;
  if (persisted.apple_music_url) metadata.appleMusicUrl = persisted.apple_music_url;
  if (persisted.youtube_music_url) metadata.youtubeMusicUrl = persisted.youtube_music_url;
  if (persisted.bandcamp_url) metadata.bandcampUrl = persisted.bandcamp_url;
  if (persisted.soundcloud_url) metadata.soundcloudUrl = persisted.soundcloud_url;
  if (persisted.artist_bio) metadata.artistBio = persisted.artist_bio;
  if (persisted.artist_wikipedia_url) metadata.artistWikipediaUrl = persisted.artist_wikipedia_url;
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

/**
 * GET /proxy/metadata/album
 *
 * Cache-first (BS#1331). The handler consults persisted state — the
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
 */
export const getAlbumMetadata: RequestHandler<object, unknown, unknown, AlbumMetadataQuery> = async (req, res) => {
  const { artistName, releaseTitle, trackTitle } = req.query;

  if (!artistName) throw new WxycError('artistName query parameter is required', 400);

  // Cache-first: consult BS's own persisted state before going to LML.
  // Catch-arm-shape rows (YT/BC/SC populated, Apple/Spotify/artwork null)
  // count as hits; the persisted nulls are served, then `searchUrlProvider`
  // fills missing streaming URLs at the bottom of the handler. iOS sees
  // the same shape it would on the LML-fallthrough path.
  //
  // A thrown DB error here would propagate as 500 and regress availability
  // versus the LML-fallthrough path (which catches LML errors and degrades
  // to synthesized search URLs). Treat any DB failure as a cache miss and
  // fall through to LML — the caller's worst-case latency goes up, but the
  // request still completes with a 200.
  let persisted: PersistedAlbumMetadata | null = null;
  try {
    persisted = await lookupAlbumMetadataByKey(artistName, releaseTitle);
  } catch (lookupError) {
    console.warn('[ProxyController] local metadata lookup failed; falling through to LML:', lookupError);
  }

  const metadata: Record<string, unknown> = persisted ? buildLocalMetadataResponse(persisted) : {};
  let upstreamCalls = 0;

  if (!persisted) {
    // Count the LML attempt before awaiting it — counting on success only
    // would conflate the LML-failure cohort with the local-hit cohort on
    // the trace explorer's `upstream_calls=0` split, masking LML incidents
    // as healthy cache-hit growth.
    upstreamCalls += 1;
    let artwork: DiscogsMatchResult | undefined;
    try {
      const lookupResponse: LookupResponse = await lmlLookupCoordinator.lookup(artistName, releaseTitle, trackTitle, {
        budgetMs: PROXY_LML_BUDGET_MS,
        caller: 'proxy-album-metadata',
      });
      artwork = lookupResponse.results?.[0]?.artwork;
    } catch (searchError) {
      console.warn('[ProxyController] LML lookup failed:', searchError);
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

  // Project the upstream-call count onto the active Sentry span so we can
  // split p50/p95 by cohort in the trace explorer. Wrap in a try/except —
  // observability must never break the request path.
  try {
    Sentry.getActiveSpan()?.setAttributes({
      'proxy.metadata.album.upstream_calls': upstreamCalls,
    });
  } catch (err) {
    console.warn('[ProxyController] failed to project Sentry attrs', err);
  }

  res.set('Cache-Control', 'private, max-age=600');
  res.status(200).json(metadata);
};

/**
 * GET /proxy/metadata/artist
 *
 * Fetches artist metadata (bio, Wikipedia URL, image) from LML by artist ID.
 * Bio is available as both raw Discogs markup (`bio`) and pre-parsed structured
 * tokens (`bioTokens`) for direct rendering by clients.
 */
export const getArtistMetadata: RequestHandler<object, unknown, unknown, ArtistMetadataQuery> = async (req, res) => {
  const { artistId } = req.query;

  if (!artistId) throw new WxycError('artistId query parameter is required', 400);

  const id = parseInt(artistId, 10);
  if (isNaN(id)) throw new WxycError('artistId must be an integer', 400);

  const artist = await getArtistDetails(id);

  const wikipediaUrl = artist.urls.find((url) => url.includes('wikipedia.org')) ?? null;

  res.set('Cache-Control', 'private, max-age=3600');
  res.status(200).json({
    discogsArtistId: artist.artist_id,
    bio: artist.profile ?? null,
    bioTokens: artist.profile_tokens ?? null,
    wikipediaUrl,
    imageUrl: artist.image_url ?? null,
  });
};

/**
 * GET /proxy/entity/resolve
 *
 * Resolves a Discogs entity (artist, release, master) by type and ID via LML.
 * Returns the entity's name and basic info.
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

  const result = await lmlResolveEntity(type as 'artist' | 'release' | 'master', entityId);

  res.set('Cache-Control', 'private, max-age=86400');
  res.status(200).json({ name: result.name, type: result.type, id: result.id });
};

/**
 * GET /proxy/spotify/track/:id
 *
 * Fetches Spotify track metadata using backend credentials.
 */
export const getSpotifyTrack: RequestHandler<SpotifyTrackParams> = async (req, res) => {
  const { id } = req.params;

  if (!id) throw new WxycError('Track ID is required', 400);

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
      res.status(404).json({ message: 'Track not found' });
      return;
    }
    console.error(`[ProxyController] Spotify track fetch failed: ${trackResponse.status}`);
    res.status(502).json({ message: 'Failed to fetch track from Spotify' });
    return;
  }

  const track: SpotifyTrackApiResponse = (await trackResponse.json()) as SpotifyTrackApiResponse;

  res.set('Cache-Control', 'private, max-age=600');
  res.status(200).json({
    title: track.name,
    artist: track.artists?.[0]?.name || '',
    album: track.album?.name || '',
    artworkUrl: track.album?.images?.[0]?.url || null,
  });
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

  const results = await searchLibrary({
    artist,
    title,
    q,
    limit: limit ? parseInt(limit, 10) : undefined,
  });

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
