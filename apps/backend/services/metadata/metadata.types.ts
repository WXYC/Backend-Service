/**
 * Metadata service type definitions
 */

/**
 * Request for fetching metadata for a flowsheet entry
 */
export interface MetadataRequest {
  // For library-linked entries (preferred - uses FK lookups)
  albumId?: number; // FK to library.id
  artistId?: number; // FK to artists.id (from library.artist_id)
  rotationId?: number; // FK to rotation.id

  // For non-library entries (fallback to string matching)
  artistName: string;
  albumTitle?: string;
  trackTitle?: string;
}

/**
 * Album-level metadata from external APIs
 */
export interface AlbumMetadataResult {
  discogsReleaseId?: number;
  discogsUrl?: string;
  releaseYear?: number;
  artworkUrl?: string;
  spotifyUrl?: string;
  appleMusicUrl?: string;
  youtubeMusicUrl?: string;
  bandcampUrl?: string;
  soundcloudUrl?: string;
}

/**
 * Artist-level metadata from external APIs
 */
export interface ArtistMetadataResult {
  discogsArtistId?: number;
  bio?: string;
  wikipediaUrl?: string;
}

/**
 * Combined metadata for flowsheet response
 */
export interface FlowsheetMetadata {
  album?: AlbumMetadataResult;
  artist?: ArtistMetadataResult;
}

/**
 * Discogs API response types
 */
export interface DiscogsSearchResult {
  id: number;
  type: 'release' | 'master' | 'artist' | 'label';
  title: string;
  cover_image?: string;
  uri?: string;
  resource_url?: string;
  master_id?: number;
}

export interface DiscogsSearchResponse {
  pagination: {
    page: number;
    pages: number;
    per_page: number;
    items: number;
  };
  results: DiscogsSearchResult[];
}

export interface DiscogsTrack {
  position: string;
  title: string;
  duration?: string;
  type_?: string;
}

export interface DiscogsRelease {
  id: number;
  title: string;
  year?: number;
  labels?: Array<{ name: string; id: number }>;
  artists?: Array<{ name: string; id: number }>;
  images?: Array<{ type: string; uri: string }>;
  tracklist?: DiscogsTrack[];
  uri?: string;
}

export interface DiscogsMaster {
  id: number;
  title: string;
  year?: number;
  artists?: Array<{ name: string; id: number }>;
  images?: Array<{ type: string; uri: string }>;
  tracklist?: DiscogsTrack[];
  uri?: string;
  main_release?: number;
}

export interface DiscogsArtist {
  id: number;
  name: string;
  profile?: string;
  urls?: string[];
  images?: Array<{ type: string; uri: string }>;
}

/**
 * Spotify API response types
 */
export interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  external_urls: {
    spotify: string;
  };
  album: {
    id: string;
    name: string;
    external_urls: {
      spotify: string;
    };
  };
  artists: Array<{
    id: string;
    name: string;
  }>;
}

export interface SpotifySearchResponse {
  tracks: {
    items: SpotifyTrack[];
    total: number;
  };
}

/**
 * iTunes/Apple Music API response types
 */
export interface ITunesResult {
  trackId?: number;
  collectionId?: number;
  artistName: string;
  collectionName?: string;
  trackName?: string;
  collectionViewUrl?: string;
  trackViewUrl?: string;
  artworkUrl100?: string;
}

export interface ITunesSearchResponse {
  resultCount: number;
  results: ITunesResult[];
}

/**
 * Rate limiter configuration
 */
export interface RateLimiterConfig {
  requestsPerMinute: number;
  burstSize?: number;
}
