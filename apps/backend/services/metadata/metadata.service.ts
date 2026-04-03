/**
 * Metadata Service - Fetches and stores metadata via LML (library-metadata-lookup).
 *
 * Called fire-and-forget on every flowsheet insert. LML search results include
 * enriched streaming URLs (Spotify, Apple Music, YouTube Music, Bandcamp,
 * SoundCloud), Discogs metadata, artist bio, and Wikipedia URL. Fallback search
 * URLs are constructed for services where LML returns null.
 */
import { MetadataRequest, AlbumMetadataResult, ArtistMetadataResult, FlowsheetMetadata } from './metadata.types.js';
import {
  setAlbumMetadata,
  setArtistMetadata,
  generateAlbumCacheKey,
  generateArtistCacheKey,
} from './metadata.cache.js';
import { searchDiscogs, getRelease, getArtistDetails, LmlSearchResult } from '../lml/lml.client.js';
import { SearchUrlProvider } from './providers/search-urls.provider.js';

const searchUrls = new SearchUrlProvider();

/**
 * Strip Discogs markup tags from bio text.
 *
 * Discogs profiles use custom markup like [a=Artist], [l=Label],
 * [url=...]...[/url]. This converts them to plain text.
 */
function cleanDiscogsBio(bio: string): string {
  return bio
    .replace(/\[a=([^\]]+)\]/g, '$1')
    .replace(/\[l=([^\]]+)\]/g, '$1')
    .replace(/\[r=([^\]]+)\]/g, '$1')
    .replace(/\[m=([^\]]+)\]/g, '$1')
    .replace(/\[url=([^\]]+)\]([^[]*)\[\/url\]/g, '$2');
}

/**
 * Check whether the LML service is configured.
 */
function isLmlConfigured(): boolean {
  return !!process.env.LIBRARY_METADATA_URL;
}

/**
 * Fetch and store metadata for a single entry (called on insert).
 */
export async function fetchAndCacheMetadata(request: MetadataRequest): Promise<FlowsheetMetadata | null> {
  if (!isLmlConfigured()) {
    console.warn('[MetadataService] LIBRARY_METADATA_URL not configured, skipping metadata fetch');
    return null;
  }

  const result: FlowsheetMetadata = {};

  try {
    // Single LML search fetches Discogs data + enriched streaming URLs
    const { albumMetadata, artistId, searchResult } = await fetchAlbumMetadata(request);
    if (albumMetadata) {
      result.album = albumMetadata;

      const cacheKey = request.albumId
        ? null
        : generateAlbumCacheKey(request.artistName, request.albumTitle || request.trackTitle);

      await setAlbumMetadata(request.albumId || null, cacheKey, albumMetadata, request.rotationId != null);
    }

    // Fetch artist metadata using the artist ID from the release, or from the search result bio
    const artistMetadata = await fetchArtistMetadata(request, artistId, searchResult);
    if (artistMetadata) {
      result.artist = artistMetadata;

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
 * Fetch album metadata from LML.
 *
 * Returns the album metadata result, the Discogs artist ID (if found), and
 * the raw LML search result (for fallback artist bio extraction).
 */
async function fetchAlbumMetadata(request: MetadataRequest): Promise<{
  albumMetadata: AlbumMetadataResult | null;
  artistId: number | null;
  searchResult: LmlSearchResult | null;
}> {
  const { artistName, albumTitle, trackTitle } = request;
  const searchTerm = albumTitle || trackTitle || '';

  let lmlResults;
  try {
    lmlResults = await searchDiscogs(artistName, searchTerm || undefined);
  } catch (error) {
    console.warn('[MetadataService] LML search failed:', error);
    // Fall through to construct search URLs
  }

  if (!lmlResults || lmlResults.results.length === 0) {
    // No LML results — construct search URLs as bare minimum
    const urls = searchUrls.getAllSearchUrls(artistName, albumTitle, trackTitle);
    return {
      albumMetadata: {
        youtubeMusicUrl: urls.youtubeMusicUrl,
        bandcampUrl: urls.bandcampUrl,
        soundcloudUrl: urls.soundcloudUrl,
      },
      artistId: null,
      searchResult: null,
    };
  }

  const topResult = lmlResults.results[0];
  const metadata: AlbumMetadataResult = {
    discogsReleaseId: topResult.release_id,
    discogsUrl: topResult.release_url,
    artworkUrl: topResult.artwork_url ?? undefined,
    releaseYear: topResult.release_year ?? undefined,
    spotifyUrl: topResult.spotify_url ?? undefined,
    appleMusicUrl: topResult.apple_music_url ?? undefined,
    youtubeMusicUrl: topResult.youtube_music_url ?? undefined,
    bandcampUrl: topResult.bandcamp_url ?? undefined,
    soundcloudUrl: topResult.soundcloud_url ?? undefined,
  };

  // Fetch release details for artist_id (needed for artist metadata)
  let artistId: number | null = null;
  try {
    const release = await getRelease(topResult.release_id);
    artistId = release.artist_id ?? null;
    // Enrich with release-level data
    if (release.year) metadata.releaseYear = release.year;
    if (release.artwork_url) metadata.artworkUrl = release.artwork_url;
  } catch (error) {
    console.warn('[MetadataService] LML release fetch failed:', error);
  }

  // Fill missing search URLs
  const urls = searchUrls.getAllSearchUrls(artistName, albumTitle, trackTitle);
  if (!metadata.youtubeMusicUrl) metadata.youtubeMusicUrl = urls.youtubeMusicUrl;
  if (!metadata.bandcampUrl) metadata.bandcampUrl = urls.bandcampUrl;
  if (!metadata.soundcloudUrl) metadata.soundcloudUrl = urls.soundcloudUrl;

  return { albumMetadata: metadata, artistId, searchResult: topResult };
}

/**
 * Fetch artist metadata from LML.
 *
 * Prefers getArtistDetails by ID (richer data). Falls back to the bio and
 * Wikipedia URL from the LML search result if no artist ID is available.
 */
async function fetchArtistMetadata(
  request: MetadataRequest,
  discogsArtistId: number | null,
  searchResult: LmlSearchResult | null
): Promise<ArtistMetadataResult | null> {
  // Try fetching full artist details by ID
  if (discogsArtistId) {
    try {
      const artist = await getArtistDetails(discogsArtistId);
      const wikipediaUrl = artist.urls.find((url) => url.includes('wikipedia.org')) ?? undefined;
      const bio = artist.profile ? cleanDiscogsBio(artist.profile) : undefined;

      return { discogsArtistId, bio, wikipediaUrl };
    } catch (error) {
      console.warn('[MetadataService] LML artist details failed:', error);
      // Fall through to search result fallback
    }
  }

  // Fallback: use bio and Wikipedia URL from the LML search result
  if (searchResult) {
    const bio = searchResult.artist_bio ? cleanDiscogsBio(searchResult.artist_bio) : undefined;
    const wikipediaUrl = searchResult.wikipedia_url ?? undefined;
    if (bio || wikipediaUrl) {
      return { discogsArtistId: discogsArtistId ?? undefined, bio, wikipediaUrl };
    }
  }

  return null;
}
