/**
 * HTTP client for the library-metadata-lookup (LML) service.
 *
 * Thin wrapper around LML's Discogs endpoints. Reads LIBRARY_METADATA_URL from
 * env. All methods throw on non-2xx responses so the proxy controller's
 * try/catch blocks can translate to appropriate HTTP error codes.
 */

/** Search result from LML's Discogs search endpoint. */
export interface LmlSearchResult {
  album: string | null;
  artist: string | null;
  release_id: number;
  release_url: string;
  artwork_url: string | null;
  confidence: number;
  release_year: number | null;
  artist_bio: string | null;
  wikipedia_url: string | null;
  spotify_url: string | null;
  apple_music_url: string | null;
  youtube_music_url: string | null;
  bandcamp_url: string | null;
  soundcloud_url: string | null;
}

export interface LmlSearchResponse {
  results: LmlSearchResult[];
  total: number;
  cached: boolean;
}

/** Track item from LML's release endpoint. */
export interface LmlTrackItem {
  position: string;
  title: string;
  duration: string | null;
  artists: string[];
}

/** Artist credit from LML's release endpoint. */
export interface LmlArtistCredit {
  artist_id: number | null;
  name: string;
  join: string;
  role: string | null;
}

/** Release metadata from LML. */
export interface LmlReleaseResponse {
  release_id: number;
  title: string;
  artist: string;
  year: number | null;
  label: string | null;
  artist_id: number | null;
  genres: string[];
  styles: string[];
  tracklist: LmlTrackItem[];
  artwork_url: string | null;
  release_url: string;
  cached: boolean;
  artists: LmlArtistCredit[];
  released: string | null;
}

/** Artist details from LML. */
export interface LmlArtistDetails {
  artist_id: number;
  name: string;
  profile: string | null;
  image_url: string | null;
  name_variations: string[];
  aliases: Array<{ id: number; name: string }>;
  members: Array<{ id: number; name: string; active: boolean }>;
  urls: string[];
  cached: boolean;
}

/** Entity resolution response from LML. */
export interface LmlEntityResponse {
  name: string;
  type: 'artist' | 'release' | 'master';
  id: number;
}

class LmlClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'LmlClientError';
  }
}

export { LmlClientError };

const TIMEOUT_MS = 5000;

function getBaseUrl(): string {
  const url = process.env.LIBRARY_METADATA_URL;
  if (!url) {
    throw new LmlClientError('LIBRARY_METADATA_URL is not configured', 503);
  }
  return url.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
}

async function lmlFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${getBaseUrl()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new LmlClientError(
        `LML responded with ${response.status}: ${response.statusText}`,
        response.status >= 500 ? 502 : response.status
      );
    }

    return response;
  } catch (e) {
    if (e instanceof LmlClientError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new LmlClientError('LML request timed out', 504);
    }
    throw new LmlClientError(`LML request failed: ${(e as Error).message}`, 502);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Search Discogs via LML.
 *
 * @param artist - Artist name
 * @param album - Album/release title
 * @returns Search results with enriched metadata
 */
export async function searchDiscogs(artist: string, album?: string): Promise<LmlSearchResponse> {
  const body: Record<string, string> = { artist };
  if (album) body.album = album;

  const response = await lmlFetch('/api/v1/discogs/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return (await response.json()) as LmlSearchResponse;
}

/**
 * Get full release metadata from LML.
 *
 * @param releaseId - Discogs release ID
 * @returns Release metadata including tracklist, genres, styles
 */
export async function getRelease(releaseId: number): Promise<LmlReleaseResponse> {
  const response = await lmlFetch(`/api/v1/discogs/release/${releaseId}`);
  return (await response.json()) as LmlReleaseResponse;
}

/**
 * Get artist details from LML.
 *
 * @param artistId - Discogs artist ID
 * @returns Artist details including bio, image, URLs
 */
export async function getArtistDetails(artistId: number): Promise<LmlArtistDetails> {
  const response = await lmlFetch(`/api/v1/discogs/artist/${artistId}`);
  return (await response.json()) as LmlArtistDetails;
}

/**
 * Resolve a Discogs entity (artist, release, or master) to its name.
 *
 * @param type - Entity type: artist, release, or master
 * @param id - Discogs entity ID
 * @returns Entity name and basic info
 */
export async function resolveEntity(type: 'artist' | 'release' | 'master', id: number): Promise<LmlEntityResponse> {
  const response = await lmlFetch(`/api/v1/discogs/entity/${type}/${id}`);
  return (await response.json()) as LmlEntityResponse;
}
