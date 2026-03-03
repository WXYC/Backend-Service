/**
 * Proxy controller - thin HTTP layer over existing services.
 *
 * All handlers require `requireAnonymousAuth` + `proxyRateLimit` middleware
 * applied at the route level.
 */
import { RequestHandler } from 'express';
import { DiscogsProvider } from '../services/metadata/providers/discogs.provider.js';
import { SpotifyProvider } from '../services/metadata/providers/spotify.provider.js';
import { AppleMusicProvider } from '../services/metadata/providers/apple.provider.js';
import { SearchUrlProvider } from '../services/metadata/providers/search-urls.provider.js';
import { getArtworkFinder } from '../services/artwork/finder.js';
import { DiscogsService } from '../services/discogs/discogs.service.js';
import { AlbumMetadataResult, ArtistMetadataResult, SpotifyTokenResponse } from '../services/metadata/metadata.types.js';

interface SpotifyTrackApiResponse {
  name: string;
  artists?: Array<{ name: string }>;
  album?: {
    name: string;
    images?: Array<{ url: string }>;
  };
}

// Reuse the existing singleton provider instances
const discogs = new DiscogsProvider();
const spotify = new SpotifyProvider();
const appleMusic = new AppleMusicProvider();
const searchUrls = new SearchUrlProvider();

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

// --- Handlers ---

/**
 * GET /proxy/artwork/search
 *
 * Searches for album artwork via the Discogs-backed ArtworkFinder.
 */
export const searchArtwork: RequestHandler<object, unknown, unknown, ArtworkSearchQuery> = async (req, res, next) => {
  const { artistName, releaseTitle } = req.query;

  if (!artistName) {
    res.status(400).json({ message: 'artistName query parameter is required' });
    return;
  }

  try {
    const finder = getArtworkFinder();
    const result = await finder.find({
      artist: artistName,
      album: releaseTitle || undefined,
    });

    res.set('Cache-Control', 'private, max-age=600');
    res.status(200).json({
      artworkUrl: result.artworkUrl,
      source: result.source,
      confidence: result.confidence,
    });
  } catch (e) {
    console.error('[ProxyController] searchArtwork error:', e);
    next(e);
  }
};

/**
 * GET /proxy/metadata/album
 *
 * Fetches album metadata from Discogs, Spotify, Apple Music, and search URL
 * providers in parallel. Mirrors the existing MetadataService.fetchAlbumMetadata
 * logic.
 */
export const getAlbumMetadata: RequestHandler<object, unknown, unknown, AlbumMetadataQuery> = async (
  req,
  res,
  next
) => {
  const { artistName, releaseTitle, trackTitle } = req.query;

  if (!artistName) {
    res.status(400).json({ message: 'artistName query parameter is required' });
    return;
  }

  try {
    const [discogsResult, spotifyUrl, appleMusicUrl] = await Promise.allSettled([
      discogs.fetchAlbumMetadata(artistName, releaseTitle || trackTitle || ''),
      spotify.getSpotifyUrl(artistName, releaseTitle, trackTitle),
      appleMusic.getAppleMusicUrl(artistName, releaseTitle, trackTitle),
    ]);

    const metadata: AlbumMetadataResult = {};

    if (discogsResult.status === 'fulfilled' && discogsResult.value) {
      Object.assign(metadata, discogsResult.value);
    }

    if (spotifyUrl.status === 'fulfilled' && spotifyUrl.value) {
      metadata.spotifyUrl = spotifyUrl.value;
    }

    if (appleMusicUrl.status === 'fulfilled' && appleMusicUrl.value) {
      metadata.appleMusicUrl = appleMusicUrl.value;
    }

    const urls = searchUrls.getAllSearchUrls(artistName, releaseTitle, trackTitle);
    metadata.youtubeMusicUrl = urls.youtubeMusicUrl;
    metadata.bandcampUrl = urls.bandcampUrl;
    metadata.soundcloudUrl = urls.soundcloudUrl;

    res.set('Cache-Control', 'private, max-age=600');
    res.status(200).json(metadata);
  } catch (e) {
    console.error('[ProxyController] getAlbumMetadata error:', e);
    next(e);
  }
};

/**
 * GET /proxy/metadata/artist
 *
 * Fetches artist metadata (bio, Wikipedia URL) from Discogs by artist ID.
 */
export const getArtistMetadata: RequestHandler<object, unknown, unknown, ArtistMetadataQuery> = async (
  req,
  res,
  next
) => {
  const { artistId } = req.query;

  if (!artistId) {
    res.status(400).json({ message: 'artistId query parameter is required' });
    return;
  }

  const id = parseInt(artistId, 10);
  if (isNaN(id)) {
    res.status(400).json({ message: 'artistId must be an integer' });
    return;
  }

  try {
    const result: ArtistMetadataResult | null = await discogs.fetchArtistMetadataById(id);

    if (!result) {
      res.status(404).json({ message: 'Artist not found' });
      return;
    }

    res.set('Cache-Control', 'private, max-age=3600');
    res.status(200).json(result);
  } catch (e) {
    console.error('[ProxyController] getArtistMetadata error:', e);
    next(e);
  }
};

/**
 * GET /proxy/entity/resolve
 *
 * Resolves a Discogs entity (artist, release, master) by type and ID.
 * Returns the entity's name and basic info.
 */
export const resolveEntity: RequestHandler<object, unknown, unknown, EntityResolveQuery> = async (req, res, next) => {
  const { type, id } = req.query;

  if (!type || !id) {
    res.status(400).json({ message: 'type and id query parameters are required' });
    return;
  }

  const validTypes = ['artist', 'release', 'master'];
  if (!validTypes.includes(type)) {
    res.status(400).json({ message: `type must be one of: ${validTypes.join(', ')}` });
    return;
  }

  const entityId = parseInt(id, 10);
  if (isNaN(entityId)) {
    res.status(400).json({ message: 'id must be an integer' });
    return;
  }

  try {
    let name: string | null = null;

    if (type === 'artist') {
      const artist = await DiscogsService.getArtist(entityId);
      name = artist?.name || null;
    } else if (type === 'release') {
      const release = await DiscogsService.getRelease(entityId);
      name = release?.title || null;
    } else if (type === 'master') {
      const master = await DiscogsService.getMaster(entityId);
      name = master?.title || null;
    }

    if (!name) {
      res.status(404).json({ message: `${type} not found` });
      return;
    }

    res.set('Cache-Control', 'private, max-age=86400');
    res.status(200).json({ name, type, id: entityId });
  } catch (e) {
    console.error('[ProxyController] resolveEntity error:', e);
    next(e);
  }
};

/**
 * GET /proxy/spotify/track/:id
 *
 * Fetches Spotify track metadata using backend credentials.
 */
export const getSpotifyTrack: RequestHandler<SpotifyTrackParams> = async (req, res, next) => {
  const { id } = req.params;

  if (!id) {
    res.status(400).json({ message: 'Track ID is required' });
    return;
  }

  try {
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

    const tokenData: SpotifyTokenResponse = await tokenResponse.json() as SpotifyTokenResponse;

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

    const track: SpotifyTrackApiResponse = await trackResponse.json() as SpotifyTrackApiResponse;

    res.set('Cache-Control', 'private, max-age=600');
    res.status(200).json({
      title: track.name,
      artist: track.artists?.[0]?.name || '',
      album: track.album?.name || '',
      artworkUrl: track.album?.images?.[0]?.url || null,
    });
  } catch (e) {
    console.error('[ProxyController] getSpotifyTrack error:', e);
    next(e);
  }
};
