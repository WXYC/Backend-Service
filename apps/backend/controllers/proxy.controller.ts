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
import { getArtworkFinder } from '../services/artwork/finder.js';
import { classify as classifyNSFW } from '../services/artwork/nsfw.js';
import {
  lookupMetadata,
  getRelease,
  getArtistDetails,
  resolveEntity as lmlResolveEntity,
  searchLibrary,
} from '../services/lml/lml.client.js';
import { LRUCache } from 'lru-cache';
import WxycError from '../utils/error.js';

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
 * GET /proxy/metadata/album
 *
 * Fetches album metadata from LML. The LML search response already includes
 * enriched streaming URLs (Spotify, Apple Music, YouTube Music, Bandcamp,
 * SoundCloud), so no direct calls to those APIs are needed.
 */
export const getAlbumMetadata: RequestHandler<object, unknown, unknown, AlbumMetadataQuery> = async (req, res) => {
  const { artistName, releaseTitle, trackTitle } = req.query;

  if (!artistName) throw new WxycError('artistName query parameter is required', 400);

  const metadata: Record<string, unknown> = {};
  const searchTerm = releaseTitle || trackTitle || '';

  let artwork;
  try {
    const lookupResponse = await lookupMetadata(artistName, releaseTitle, trackTitle);
    artwork = lookupResponse.results?.[0]?.artwork;
  } catch (searchError) {
    console.warn('[ProxyController] LML lookup failed:', searchError);
  }

  if (artwork) {
    metadata.discogsReleaseId = artwork.release_id;
    metadata.discogsUrl = artwork.release_url;
    // Drop Discogs spacer.gif placeholder so the iOS client knows to draw its
    // own placeholder rather than rendering a broken/blank image. See #649
    // for the full callsite audit.
    metadata.artworkUrl =
      artwork.artwork_url && !artwork.artwork_url.includes('spacer.gif') ? artwork.artwork_url : undefined;

    // Artist bio and Wikipedia from lookup result
    if (artwork.artist_bio) metadata.artistBio = artwork.artist_bio;
    if (artwork.wikipedia_url) metadata.artistWikipediaUrl = artwork.wikipedia_url;

    // Streaming URLs from LML enrichment
    if (artwork.spotify_url) metadata.spotifyUrl = artwork.spotify_url;
    if (artwork.apple_music_url) metadata.appleMusicUrl = artwork.apple_music_url;
    if (artwork.youtube_music_url) metadata.youtubeMusicUrl = artwork.youtube_music_url;
    if (artwork.bandcamp_url) metadata.bandcampUrl = artwork.bandcamp_url;
    if (artwork.soundcloud_url) metadata.soundcloudUrl = artwork.soundcloud_url;

    // Fetch enriched release details (tracklist, genres, styles)
    try {
      const release = await getRelease(artwork.release_id);
      metadata.releaseYear = release.year ?? undefined;
      metadata.genres = release.genres.length > 0 ? release.genres : undefined;
      metadata.styles = release.styles.length > 0 ? release.styles : undefined;
      metadata.label = release.label ?? undefined;
      metadata.discogsArtistId = release.artist_id ?? null;
      metadata.fullReleaseDate = release.released ?? undefined;
      if (release.tracklist.length > 0) {
        metadata.tracklist = release.tracklist.map((t) => ({
          position: t.position,
          title: t.title,
          duration: t.duration ?? undefined,
        }));
      }
      // Prefer release artwork over lookup artwork — but still filter out
      // spacer.gif placeholders (see #649).
      if (release.artwork_url && !release.artwork_url.includes('spacer.gif')) {
        metadata.artworkUrl = release.artwork_url;
      }
    } catch (releaseError) {
      console.warn('[ProxyController] Failed to fetch release details from LML:', releaseError);
    }
  }

  // Fallback: construct search URLs for services without LML-provided URLs
  const query = searchTerm ? `${artistName} ${searchTerm}` : artistName;
  const encodedQuery = encodeURIComponent(query);
  if (!metadata.youtubeMusicUrl) metadata.youtubeMusicUrl = `https://music.youtube.com/search?q=${encodedQuery}`;
  if (!metadata.bandcampUrl) metadata.bandcampUrl = `https://bandcamp.com/search?q=${encodedQuery}`;
  if (!metadata.soundcloudUrl) metadata.soundcloudUrl = `https://soundcloud.com/search?q=${encodedQuery}`;

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
