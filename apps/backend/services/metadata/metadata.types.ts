/**
 * Metadata service type definitions
 */

/**
 * Request for fetching metadata for a flowsheet entry
 */
export interface MetadataRequest {
  // For library-linked entries (used to pass artist_id for LML artist lookup)
  albumId?: number;
  artistId?: number;

  // Entry fields for LML search
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
