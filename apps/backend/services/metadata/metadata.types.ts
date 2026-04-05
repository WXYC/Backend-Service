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
