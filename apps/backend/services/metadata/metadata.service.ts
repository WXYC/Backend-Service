/**
 * Metadata Service - Orchestrates fetching and storing metadata from external APIs
 */
import {
  MetadataRequest,
  AlbumMetadataResult,
  ArtistMetadataResult,
  FlowsheetMetadata,
} from './metadata.types.js';
import {
  setAlbumMetadata,
  setArtistMetadata,
  generateAlbumCacheKey,
  generateArtistCacheKey,
} from './metadata.cache.js';
import { DiscogsProvider } from './providers/discogs.provider.js';
import { SpotifyProvider } from './providers/spotify.provider.js';
import { AppleMusicProvider } from './providers/apple.provider.js';
import { SearchUrlProvider } from './providers/search-urls.provider.js';

// Provider instances (created once, reused)
const discogs = new DiscogsProvider();
const spotify = new SpotifyProvider();
const appleMusic = new AppleMusicProvider();
const searchUrls = new SearchUrlProvider();

/**
 * Fetch and store metadata for a single entry (called on insert)
 */
export async function fetchAndCacheMetadata(
  request: MetadataRequest
): Promise<FlowsheetMetadata | null> {
  const result: FlowsheetMetadata = {};

  try {
    // Fetch album metadata
    const albumMetadata = await fetchAlbumMetadata(request);
    if (albumMetadata) {
      result.album = albumMetadata;

      // Store the album metadata
      const cacheKey = request.albumId
        ? null
        : generateAlbumCacheKey(request.artistName, request.albumTitle || request.trackTitle);

      await setAlbumMetadata(
        request.albumId || null,
        cacheKey,
        albumMetadata,
        request.rotationId != null
      );
    }

    // Fetch artist metadata
    const artistMetadata = await fetchArtistMetadata(request);
    if (artistMetadata) {
      result.artist = artistMetadata;

      // Store the artist metadata
      const cacheKey = request.artistId ? null : generateArtistCacheKey(request.artistName);

      await setArtistMetadata(request.artistId || null, cacheKey, artistMetadata);
    }

    return result;
  } catch (error) {
    console.error('[MetadataService] fetchAndCacheMetadata error:', error);
    return null;
  }
}

/**
 * Fetch album metadata from all providers
 */
async function fetchAlbumMetadata(request: MetadataRequest): Promise<AlbumMetadataResult | null> {
  const { artistName, albumTitle, trackTitle } = request;

  // Fetch from all providers in parallel
  const [discogsResult, spotifyUrl, appleMusicUrl] = await Promise.allSettled([
    discogs.fetchAlbumMetadata(artistName, albumTitle || trackTitle || ''),
    spotify.getSpotifyUrl(artistName, albumTitle, trackTitle),
    appleMusic.getAppleMusicUrl(artistName, albumTitle, trackTitle),
  ]);

  // Merge results
  const metadata: AlbumMetadataResult = {};

  // Discogs data
  if (discogsResult.status === 'fulfilled' && discogsResult.value) {
    Object.assign(metadata, discogsResult.value);
  }

  // Spotify URL
  if (spotifyUrl.status === 'fulfilled' && spotifyUrl.value) {
    metadata.spotifyUrl = spotifyUrl.value;
  }

  // Apple Music URL
  if (appleMusicUrl.status === 'fulfilled' && appleMusicUrl.value) {
    metadata.appleMusicUrl = appleMusicUrl.value;
  }

  // Search URLs (always available - no API calls)
  const urls = searchUrls.getAllSearchUrls(artistName, albumTitle, trackTitle);
  metadata.youtubeMusicUrl = urls.youtubeMusicUrl;
  metadata.bandcampUrl = urls.bandcampUrl;
  metadata.soundcloudUrl = urls.soundcloudUrl;

  // Return null if we got nothing meaningful
  if (!metadata.discogsUrl && !metadata.spotifyUrl && !metadata.appleMusicUrl) {
    // Still return search URLs even if no API results
    if (metadata.youtubeMusicUrl) {
      return metadata;
    }
    return null;
  }

  return metadata;
}

/**
 * Fetch artist metadata from Discogs
 */
async function fetchArtistMetadata(request: MetadataRequest): Promise<ArtistMetadataResult | null> {
  const { artistName } = request;

  try {
    return await discogs.fetchArtistMetadata(artistName);
  } catch (error) {
    console.error('[MetadataService] fetchArtistMetadata error:', error);
    return null;
  }
}
