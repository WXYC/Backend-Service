/**
 * Metadata Service - Fetches metadata from LML (library-metadata-lookup).
 *
 * Called fire-and-forget on every flowsheet insert. The caller persists the
 * returned metadata directly on the flowsheet row. Uses LML's /lookup endpoint
 * which provides artist correction, title normalization, fallback strategies,
 * artwork, streaming URLs, and artist metadata in a single call.
 */
import { MetadataRequest, AlbumMetadataResult, ArtistMetadataResult, FlowsheetMetadata } from './metadata.types.js';
import { lookupMetadata } from '../lml/lml.client.js';
import type { DiscogsMatchResult } from '../lml/lml.client.js';
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
 * Fetch metadata for a single flowsheet entry from LML.
 *
 * Returns album and artist metadata, or null if LML is not configured or
 * an unrecoverable error occurs. The caller is responsible for persisting
 * the result (e.g., updating the flowsheet row).
 */
export async function fetchMetadata(request: MetadataRequest): Promise<FlowsheetMetadata | null> {
  if (!isLmlConfigured()) {
    console.warn('[MetadataService] LIBRARY_METADATA_URL not configured, skipping metadata fetch');
    return null;
  }

  const { artistName, albumTitle, trackTitle } = request;
  const result: FlowsheetMetadata = {};

  let artwork: DiscogsMatchResult | null = null;
  try {
    const lookupResponse = await lookupMetadata(artistName, albumTitle, trackTitle);
    artwork = lookupResponse.results?.[0]?.artwork ?? null;
  } catch (error) {
    console.warn('[MetadataService] LML lookup failed:', error);
  }

  if (artwork) {
    result.album = extractAlbumMetadata(artwork);
    result.artist = extractArtistMetadata(artwork) ?? undefined;
  }

  // Fill missing search URLs (always available, no API calls)
  const urls = searchUrls.getAllSearchUrls(artistName, albumTitle, trackTitle);
  if (!result.album) {
    result.album = {
      youtubeMusicUrl: urls.youtubeMusicUrl,
      bandcampUrl: urls.bandcampUrl,
      soundcloudUrl: urls.soundcloudUrl,
    };
  } else {
    if (!result.album.youtubeMusicUrl) result.album.youtubeMusicUrl = urls.youtubeMusicUrl;
    if (!result.album.bandcampUrl) result.album.bandcampUrl = urls.bandcampUrl;
    if (!result.album.soundcloudUrl) result.album.soundcloudUrl = urls.soundcloudUrl;
  }

  return result;
}

/**
 * Extract album metadata from a DiscogsMatchResult.
 */
function extractAlbumMetadata(artwork: DiscogsMatchResult): AlbumMetadataResult {
  return {
    discogsReleaseId: artwork.release_id,
    discogsUrl: artwork.release_url,
    artworkUrl: artwork.artwork_url ?? undefined,
    releaseYear: artwork.release_year ?? undefined,
    spotifyUrl: artwork.spotify_url ?? undefined,
    appleMusicUrl: artwork.apple_music_url ?? undefined,
    youtubeMusicUrl: artwork.youtube_music_url ?? undefined,
    bandcampUrl: artwork.bandcamp_url ?? undefined,
    soundcloudUrl: artwork.soundcloud_url ?? undefined,
  };
}

/**
 * Extract artist metadata from a DiscogsMatchResult.
 */
function extractArtistMetadata(artwork: DiscogsMatchResult): ArtistMetadataResult | null {
  const bio = artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : undefined;
  const wikipediaUrl = artwork.wikipedia_url ?? undefined;
  if (bio || wikipediaUrl) {
    return { bio, wikipediaUrl };
  }
  return null;
}
