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
  lookupMetadata,
  getRelease,
  getArtistDetails,
  resolveEntity as lmlResolveEntity,
  searchLibrary,
  LmlClientError,
} from '@wxyc/lml-client';
import type { DiscogsMatchResult, DiscogsReleaseMetadata, DiscogsTrackItem, LookupResponse } from '@wxyc/lml-client';
import { getDiscogsReleaseIdByLegacyId } from '../services/library.service.js';
import { filterSpacerGif, isSyntheticArtwork } from '../services/metadata/metadata.service.js';
import { SearchUrlProvider } from '../services/metadata/providers/search-urls.provider.js';
import { LRUCache } from 'lru-cache';
import WxycError from '../utils/error.js';

// Shared instance — stateless, safe to reuse across requests. Centralizes
// fallback-URL synthesis so this controller, the runtime metadata service,
// and the flowsheet-metadata-backfill job all produce identical URLs for
// the same inputs (BS#889).
const searchUrlProvider = new SearchUrlProvider();

/**
 * Toggle the single-call /proxy/metadata/album path.
 *
 * When `'true'`, we pass `extended: true` to LML's `/api/v1/lookup` and read
 * the tracklist/genres/styles/label/full_release_date/discogs_artist_id off
 * the lookup response's `artwork` block directly — no follow-up
 * `/api/v1/discogs/release/{id}` call. Available since `@wxyc/shared@1.5.0`
 * + LML#335.
 *
 * Defaults off so the flag can ship before production traffic is cut over.
 * Flip in Railway env (`PROXY_METADATA_SINGLE_LOOKUP=true`) once staging
 * smoke-tests confirm response parity. Matches the env-var pattern used
 * for AUTH_BYPASS / TEST_RATE_LIMITING — there's no centralized
 * feature-flag module in this repo.
 *
 * After the cutover is stable, the flag and the legacy two-call branch get
 * deleted together (separate cleanup PR).
 */
function singleLookupEnabled(): boolean {
  return process.env.PROXY_METADATA_SINGLE_LOOKUP === 'true';
}

/**
 * Caller-honored LML budget forwarded as `X-Caller-Budget-Ms`
 * (WXYC/library-metadata-lookup#345). Set tightly because the proxy path is
 * user-visible (iOS playlist + dj-site cover-art); we'd rather degrade to
 * synthesized fallback URLs than hold the response on an obscure-artist
 * cascade burning Discogs quota for a response we'll discard. Matches the
 * 5 s deadline used by the rotation picker (BS#992) and the
 * WXYC/library-metadata-lookup#337 re-measurement target.
 */
const PROXY_LML_BUDGET_MS = Number(process.env.PROXY_LML_BUDGET_MS ?? 5000);

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
  metadata.artworkUrl = filterSpacerGif(artwork.artwork_url);

  if (artwork.artist_bio) metadata.artistBio = artwork.artist_bio;
  if (artwork.wikipedia_url) metadata.artistWikipediaUrl = artwork.wikipedia_url;

  if (artwork.spotify_url) metadata.spotifyUrl = artwork.spotify_url;
  if (artwork.apple_music_url) metadata.appleMusicUrl = artwork.apple_music_url;
  if (artwork.youtube_music_url) metadata.youtubeMusicUrl = artwork.youtube_music_url;
  if (artwork.bandcamp_url) metadata.bandcampUrl = artwork.bandcamp_url;
  if (artwork.soundcloud_url) metadata.soundcloudUrl = artwork.soundcloud_url;
}

/**
 * Populate the release-detail fields (tracklist, genres, styles, label,
 * full release date, discogs artist id, release year). Source-agnostic:
 * works the same on a `DiscogsMatchResult` with `extended=true` (new path)
 * or on a `DiscogsReleaseMetadata` from a separate `getRelease()` call
 * (legacy two-call path).
 *
 * On the extended path the release artwork URL is the same as the lookup
 * artwork URL, so the `prefer release artwork over lookup` logic is a no-op
 * but kept for symmetry with the legacy path.
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
  metadata.genres = release.genres && release.genres.length > 0 ? release.genres : undefined;
  metadata.styles = release.styles && release.styles.length > 0 ? release.styles : undefined;
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
  // Prefer release artwork over lookup artwork — but still filter out
  // spacer.gif placeholders (see #649). On the extended path the values
  // are typically identical; on the legacy path the release fetch can
  // surface a higher-quality image.
  const releaseArtwork = filterSpacerGif(release.artwork_url);
  if (releaseArtwork) metadata.artworkUrl = releaseArtwork;
}

/**
 * GET /proxy/metadata/album
 *
 * Fetches album metadata from LML. The LML search response already includes
 * enriched streaming URLs (Spotify, Apple Music, YouTube Music, Bandcamp,
 * SoundCloud), so no direct calls to those APIs are needed.
 *
 * Two code paths, selected by `PROXY_METADATA_SINGLE_LOOKUP`:
 *
 * - **Single-call** (flag on, future default): LML `/api/v1/lookup` with
 *   `extended: true` returns release details inline on the top-1 artwork
 *   block. One round-trip iOS → BS → LML; the LML pipeline runs its release
 *   and artist fetches concurrently server-side. Subsecond p50 target.
 *
 * - **Legacy two-call** (flag off, current default): one lookup followed
 *   by a separate `/api/v1/discogs/release/{id}` for the release details
 *   we want to surface. Two LML round-trips, the second one re-fetching
 *   release data LML already loaded ~100ms earlier during enrichment.
 *
 * Sentry annotates the active span with
 * `proxy.metadata.album.upstream_calls` so the cutover can be graphed by
 * cohort in the trace explorer.
 */
export const getAlbumMetadata: RequestHandler<object, unknown, unknown, AlbumMetadataQuery> = async (req, res) => {
  const { artistName, releaseTitle, trackTitle } = req.query;

  if (!artistName) throw new WxycError('artistName query parameter is required', 400);

  const useSingleLookup = singleLookupEnabled();
  const metadata: Record<string, unknown> = {};
  let upstreamCalls = 0;

  let artwork: DiscogsMatchResult | undefined;
  try {
    let lookupResponse: LookupResponse;
    if (useSingleLookup) {
      lookupResponse = await lookupMetadata(artistName, releaseTitle, trackTitle, {
        extended: true,
        budgetMs: PROXY_LML_BUDGET_MS,
      });
    } else {
      lookupResponse = await lookupMetadata(artistName, releaseTitle, trackTitle, {
        budgetMs: PROXY_LML_BUDGET_MS,
      });
    }
    upstreamCalls += 1;
    artwork = lookupResponse.results?.[0]?.artwork;
  } catch (searchError) {
    console.warn('[ProxyController] LML lookup failed:', searchError);
  }

  if (artwork) {
    populateCommonMetadataFields(metadata, artwork);

    if (useSingleLookup) {
      // The lookup response already carries the release-detail fields
      // (`extended: true`); no follow-up call needed.
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
    } else {
      // Legacy path: fetch enriched release details with a second LML call.
      try {
        const release = await getRelease(artwork.release_id);
        upstreamCalls += 1;
        populateReleaseMetadata(metadata, release);
      } catch (releaseError) {
        console.warn('[ProxyController] Failed to fetch release details from LML:', releaseError);
      }
    }
  }

  // Fallback: construct search URLs for services without LML-provided URLs.
  // Per-service semantics live in `SearchUrlProvider` (BS#889) — each
  // service uses a different field-fallback order, so the URLs are no
  // longer guaranteed to share a query string. Old behavior was a single
  // combined `${artistName} ${searchTerm}` for all three; the new behavior
  // matches the runtime path and the recurring backfill so iOS gets
  // identical search URLs regardless of which BS path produced them.
  //
  // Post-BS#1185: Spotify and Apple Music also have search-URL fallbacks so
  // iOS doesn't show greyed buttons when LML fails or returns zero results.
  const fallbackUrls = searchUrlProvider.getAllSearchUrls(artistName, releaseTitle, trackTitle);
  if (!metadata.spotifyUrl) metadata.spotifyUrl = fallbackUrls.spotifyUrl;
  if (!metadata.appleMusicUrl) metadata.appleMusicUrl = fallbackUrls.appleMusicUrl;
  if (!metadata.youtubeMusicUrl) metadata.youtubeMusicUrl = fallbackUrls.youtubeMusicUrl;
  if (!metadata.bandcampUrl) metadata.bandcampUrl = fallbackUrls.bandcampUrl;
  if (!metadata.soundcloudUrl) metadata.soundcloudUrl = fallbackUrls.soundcloudUrl;

  // Project the upstream-call count + mode onto the active Sentry span so
  // we can split p50/p95 by cohort in the trace explorer. Wrap in a
  // try/except — observability must never break the request path.
  try {
    Sentry.getActiveSpan()?.setAttributes({
      'proxy.metadata.album.upstream_calls': upstreamCalls,
      'proxy.metadata.album.single_lookup': useSingleLookup,
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
