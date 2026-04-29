/**
 * HTTP client for the library-metadata-lookup (LML) service.
 *
 * Thin wrapper around LML's endpoints. Reads LIBRARY_METADATA_URL from env.
 * All methods throw on non-2xx responses so the proxy controller's try/catch
 * blocks can translate to appropriate HTTP error codes.
 *
 * Response types are generated from wxyc-shared/api.yaml — see @wxyc/shared/dtos.
 */

import * as Sentry from '@sentry/node';

import type {
  DiscogsReleaseMetadata,
  DiscogsArtistDetails,
  DiscogsTrackReleasesResponse,
  EntityResolveResponse,
  LibrarySearchResponse,
  LookupResponse,
  StreamingCheckResponse,
} from '@wxyc/shared/dtos';

export type {
  DiscogsMatchResult,
  DiscogsReleaseMetadata,
  DiscogsTrackItem,
  DiscogsArtistCredit,
  DiscogsArtistDetails,
  DiscogsResolvedToken,
  DiscogsReleaseInfo,
  DiscogsTrackReleasesResponse,
  EntityResolveResponse,
  LibrarySearchItem,
  LibrarySearchResponse,
  LookupRequest,
  LookupResponse,
  LookupResultItem,
  StreamingCheckResponse,
  StreamingSourceMatch,
  StreamingCheckSources,
} from '@wxyc/shared/dtos';

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

  // Merge LML_API_KEY bearer header at the single chokepoint. LML rolls auth
  // out gradually (LML_REQUIRE_AUTH defaults false on the server), so sending
  // the header before the flag flips is harmless.
  const apiKey = process.env.LML_API_KEY;
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(url, {
      ...init,
      headers,
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
 * Look up a release in the library catalog via LML's full search pipeline.
 *
 * Provides artist correction, title normalization, fallback strategies,
 * artwork, streaming URLs, and artist metadata in a single call.
 *
 * @param artist - Artist name
 * @param album - Album/release title
 * @param song - Song/track title
 * @returns Lookup results with library items and enriched artwork metadata
 */
export async function lookupMetadata(artist: string, album?: string, song?: string): Promise<LookupResponse> {
  // Wrap the call in a Sentry span so the LML response's cache_stats (memory
  // hits / pg hits / pg misses / api calls / pg time / api time) lands as
  // attributes on the BS transaction's trace. Filterable in Sentry's trace
  // explorer (e.g. `lml.cache.api_calls > 0`) so per-callsite instrumentation
  // isn't needed for the metadata-backfill pilot or the runtime hot path.
  // Sibling LML-side projection at WXYC/library-metadata-lookup#213.
  return Sentry.startSpan({ name: 'lml.lookup', op: 'http.client' }, async (span) => {
    // LML's /lookup contract requires `raw_message` even when artist/album/song
    // are already structured. Synthesize a free-form description that the LML
    // parser would have produced — matches the e2e fixtures in LML's repo.
    const rawMessage = [artist, album, song].filter(Boolean).join(' - ');
    const body: Record<string, string> = { artist, raw_message: rawMessage };
    if (album) body.album = album;
    if (song) body.song = song;

    const response = await lmlFetch('/api/v1/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const parsed = (await response.json()) as LookupResponse;

    // cache_stats schema is freeform today (additionalProperties: true). Until
    // wxyc-shared#86 tightens the type, treat it as a loose record and only
    // forward numeric fields onto the span.
    const stats = (parsed as { cache_stats?: Record<string, unknown> }).cache_stats;
    if (stats && span) {
      const attrs: Record<string, number> = {};
      for (const [key, value] of Object.entries(stats)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          attrs[`lml.cache.${key}`] = value;
        }
      }
      if (Object.keys(attrs).length > 0) {
        span.setAttributes(attrs);
      }
    }

    return parsed;
  });
}

/**
 * Get full release metadata from LML.
 *
 * @param releaseId - Discogs release ID
 * @returns Release metadata including tracklist, genres, styles
 */
export async function getRelease(releaseId: number): Promise<DiscogsReleaseMetadata> {
  const response = await lmlFetch(`/api/v1/discogs/release/${releaseId}`);
  return (await response.json()) as DiscogsReleaseMetadata;
}

/**
 * Get artist details from LML.
 *
 * @param artistId - Discogs artist ID
 * @returns Artist details including bio, image, URLs
 */
export async function getArtistDetails(artistId: number): Promise<DiscogsArtistDetails> {
  const response = await lmlFetch(`/api/v1/discogs/artist/${artistId}`);
  return (await response.json()) as DiscogsArtistDetails;
}

/**
 * Resolve a Discogs entity (artist, release, or master) to its name.
 *
 * @param type - Entity type: artist, release, or master
 * @param id - Discogs entity ID
 * @returns Entity name and basic info
 */
export async function resolveEntity(type: 'artist' | 'release' | 'master', id: number): Promise<EntityResolveResponse> {
  const response = await lmlFetch(`/api/v1/discogs/entity/${type}/${id}`);
  return (await response.json()) as EntityResolveResponse;
}

/**
 * Search for all releases containing a track via LML.
 *
 * @param track - Track/song title to search for
 * @param artist - Optional artist name for filtering
 * @param limit - Maximum number of results (default 20)
 * @returns List of releases containing the track
 */
export async function searchTrackReleases(
  track: string,
  artist?: string,
  limit = 20
): Promise<DiscogsTrackReleasesResponse> {
  const params = new URLSearchParams({ track });
  if (artist) params.set('artist', artist);
  if (limit !== 20) params.set('limit', String(limit));

  const response = await lmlFetch(`/api/v1/discogs/track-releases?${params}`);
  return (await response.json()) as DiscogsTrackReleasesResponse;
}

/**
 * Validate that a track by an artist exists on a release.
 *
 * Fetches the full release from LML and checks the tracklist client-side.
 * Uses case-insensitive substring matching on track title and artist name.
 *
 * @param releaseId - Discogs release ID
 * @param track - Track title to find
 * @param artist - Artist name to find
 * @returns true if the track by the artist is found on the release
 */
export async function validateTrackOnRelease(releaseId: number, track: string, artist: string): Promise<boolean> {
  const release = await getRelease(releaseId);

  const trackLower = track.toLowerCase();
  const artistLower = artist.toLowerCase();

  for (const item of release.tracklist) {
    const itemTitle = item.title.toLowerCase();

    // Check if track title matches (substring in either direction)
    if (!trackLower.includes(itemTitle) && !itemTitle.includes(trackLower)) {
      continue;
    }

    // Check per-track artists first (for compilations)
    if (item.artists.length > 0) {
      for (const trackArtist of item.artists) {
        const normalized = trackArtist.toLowerCase().split('(')[0].trim();
        if (artistLower.includes(normalized) || normalized.includes(artistLower)) {
          return true;
        }
      }
      continue;
    }

    // Fall back to release-level artist (strip Discogs numbering like "(2)")
    const releaseArtist = release.artist.toLowerCase().split('(')[0].trim();
    if (artistLower.includes(releaseArtist) || releaseArtist.includes(artistLower)) {
      return true;
    }
  }

  return false;
}

/**
 * Check streaming availability for an artist+title pair.
 *
 * @param artist - Artist name
 * @param title - Album title
 * @returns Streaming availability result with per-source URLs
 */
export async function checkStreamingAvailability(artist: string, title: string): Promise<StreamingCheckResponse> {
  const response = await lmlFetch('/api/v1/streaming-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ artist, title }),
  });

  return (await response.json()) as StreamingCheckResponse;
}

/**
 * Search the library catalog via LML.
 *
 * @param params - Search parameters (artist, title, q, limit)
 * @returns Library search results
 */
export async function searchLibrary(params: {
  artist?: string;
  title?: string;
  q?: string;
  limit?: number;
}): Promise<LibrarySearchResponse> {
  const searchParams = new URLSearchParams();
  if (params.artist) searchParams.set('artist', params.artist);
  if (params.title) searchParams.set('title', params.title);
  if (params.q) searchParams.set('q', params.q);
  if (params.limit) searchParams.set('limit', String(params.limit));

  const response = await lmlFetch(`/api/v1/library/search?${searchParams}`);
  return (await response.json()) as LibrarySearchResponse;
}

/**
 * Check whether the LML service is configured.
 */
export function isLmlConfigured(): boolean {
  return !!process.env.LIBRARY_METADATA_URL;
}
