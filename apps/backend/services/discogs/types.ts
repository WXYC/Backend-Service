/**
 * Type definitions for Discogs API responses.
 *
 * Ported from request-parser discogs/models.py
 */

export {
  DiscogsTrackItem,
  DiscogsTrackAlbumResponse,
  DiscogsReleaseInfo,
  DiscogsTrackReleasesResponse,
  DiscogsReleaseMetadata,
  DiscogsSearchRequest,
  DiscogsSearchResult,
  DiscogsSearchResponse,
} from '../requestLine/types.js';

/**
 * Raw Discogs API search result.
 */
export interface RawDiscogsSearchResult {
  id: number;
  title: string;
  thumb?: string;
  cover_image?: string;
  type?: string;
  year?: string;
  country?: string;
  format?: string[];
  label?: string[];
  genre?: string[];
  style?: string[];
  resource_url?: string;
}

/**
 * Raw Discogs API release response.
 */
export interface RawDiscogsRelease {
  id: number;
  title: string;
  artists?: Array<{ name: string; id: number }>;
  year?: number;
  labels?: Array<{ name: string; id: number }>;
  genres?: string[];
  styles?: string[];
  tracklist?: Array<{
    position: string;
    title: string;
    duration?: string;
    artists?: Array<{ name: string }>;
  }>;
  images?: Array<{ uri: string; type: string }>;
}

/**
 * Discogs API search response structure.
 */
export interface RawDiscogsSearchResponse {
  pagination?: {
    page: number;
    pages: number;
    per_page: number;
    items: number;
  };
  results: RawDiscogsSearchResult[];
}

/**
 * Raw Discogs API master release response.
 * Masters represent the canonical version of a release across all pressings.
 */
export interface RawDiscogsMaster {
  id: number;
  title: string;
  year?: number;
  artists?: Array<{ id: number; name: string }>;
  images?: Array<{ type: string; uri: string; width?: number; height?: number }>;
  genres?: string[];
  styles?: string[];
  tracklist?: Array<{
    position: string;
    title: string;
    duration?: string;
  }>;
  main_release?: number;
  main_release_url?: string;
  versions_url?: string;
  num_for_sale?: number;
  lowest_price?: number;
}

/**
 * Raw Discogs API artist response.
 */
export interface RawDiscogsArtist {
  id: number;
  name: string;
  profile?: string;
  urls?: string[];
  images?: Array<{ type: string; uri: string; width?: number; height?: number }>;
  members?: Array<{ id: number; name: string; active?: boolean }>;
  groups?: Array<{ id: number; name: string; active?: boolean }>;
  namevariations?: string[];
  releases_url?: string;
}
