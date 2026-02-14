/**
 * Metadata storage - simple database operations for metadata persistence
 */
import { db } from '@wxyc/database';
import {
  album_metadata,
  artist_metadata,
  AlbumMetadata as AlbumMetadataRow,
  ArtistMetadata as ArtistMetadataRow,
  NewAlbumMetadata,
  NewArtistMetadata,
} from '@wxyc/database';
import { eq } from 'drizzle-orm';
import { AlbumMetadataResult, ArtistMetadataResult } from './metadata.types.js';

/**
 * Generate a cache key for string-based lookups (when no album_id/artist_id)
 */
export function generateAlbumCacheKey(artistName: string, albumTitle?: string): string {
  const normalized = `${artistName.toLowerCase().trim()}-${(albumTitle || '').toLowerCase().trim()}`;
  return normalized.substring(0, 512);
}

export function generateArtistCacheKey(artistName: string): string {
  return artistName.toLowerCase().trim().substring(0, 256);
}

/**
 * Get album metadata by album_id or cache_key
 */
export async function getAlbumMetadata(albumId: number | null, cacheKey?: string): Promise<AlbumMetadataResult | null> {
  let row: AlbumMetadataRow | undefined;

  if (albumId) {
    const result = await db.select().from(album_metadata).where(eq(album_metadata.album_id, albumId)).limit(1);
    row = result[0];
  } else if (cacheKey) {
    const result = await db.select().from(album_metadata).where(eq(album_metadata.cache_key, cacheKey)).limit(1);
    row = result[0];
  }

  if (!row) return null;

  return rowToAlbumResult(row);
}

/**
 * Set album metadata (insert or update)
 */
export async function setAlbumMetadata(
  albumId: number | null,
  cacheKey: string | null,
  data: AlbumMetadataResult,
  isRotation: boolean
): Promise<void> {
  const insertData: NewAlbumMetadata = {
    album_id: albumId,
    cache_key: cacheKey,
    discogs_release_id: data.discogsReleaseId,
    discogs_url: data.discogsUrl,
    release_year: data.releaseYear,
    artwork_url: data.artworkUrl,
    spotify_url: data.spotifyUrl,
    apple_music_url: data.appleMusicUrl,
    youtube_music_url: data.youtubeMusicUrl,
    bandcamp_url: data.bandcampUrl,
    soundcloud_url: data.soundcloudUrl,
    is_rotation: isRotation,
    last_accessed: new Date(),
    created_at: new Date(),
  };

  // Try to find existing entry
  let existingId: number | null = null;
  if (albumId) {
    const existing = await db
      .select({ id: album_metadata.id })
      .from(album_metadata)
      .where(eq(album_metadata.album_id, albumId))
      .limit(1);
    if (existing[0]) existingId = existing[0].id;
  } else if (cacheKey) {
    const existing = await db
      .select({ id: album_metadata.id })
      .from(album_metadata)
      .where(eq(album_metadata.cache_key, cacheKey))
      .limit(1);
    if (existing[0]) existingId = existing[0].id;
  }

  if (existingId) {
    // Update existing
    await db
      .update(album_metadata)
      .set({
        ...insertData,
        created_at: undefined, // Don't update created_at
      })
      .where(eq(album_metadata.id, existingId));
  } else {
    // Insert new
    await db.insert(album_metadata).values(insertData);
  }
}

/**
 * Check if album metadata exists
 */
export async function albumMetadataExists(albumId: number | null, cacheKey?: string): Promise<boolean> {
  if (albumId) {
    const result = await db
      .select({ id: album_metadata.id })
      .from(album_metadata)
      .where(eq(album_metadata.album_id, albumId))
      .limit(1);
    return result.length > 0;
  } else if (cacheKey) {
    const result = await db
      .select({ id: album_metadata.id })
      .from(album_metadata)
      .where(eq(album_metadata.cache_key, cacheKey))
      .limit(1);
    return result.length > 0;
  }
  return false;
}

/**
 * Get artist metadata by artist_id or cache_key
 */
export async function getArtistMetadata(
  artistId: number | null,
  cacheKey?: string
): Promise<ArtistMetadataResult | null> {
  let row: ArtistMetadataRow | undefined;

  if (artistId) {
    const result = await db.select().from(artist_metadata).where(eq(artist_metadata.artist_id, artistId)).limit(1);
    row = result[0];
  } else if (cacheKey) {
    const result = await db.select().from(artist_metadata).where(eq(artist_metadata.cache_key, cacheKey)).limit(1);
    row = result[0];
  }

  if (!row) return null;

  return rowToArtistResult(row);
}

/**
 * Set artist metadata (insert or update)
 */
export async function setArtistMetadata(
  artistId: number | null,
  cacheKey: string | null,
  data: ArtistMetadataResult
): Promise<void> {
  const insertData: NewArtistMetadata = {
    artist_id: artistId,
    cache_key: cacheKey,
    discogs_artist_id: data.discogsArtistId,
    bio: data.bio,
    wikipedia_url: data.wikipediaUrl,
    last_accessed: new Date(),
    created_at: new Date(),
  };

  // Try to find existing entry
  let existingId: number | null = null;
  if (artistId) {
    const existing = await db
      .select({ id: artist_metadata.id })
      .from(artist_metadata)
      .where(eq(artist_metadata.artist_id, artistId))
      .limit(1);
    if (existing[0]) existingId = existing[0].id;
  } else if (cacheKey) {
    const existing = await db
      .select({ id: artist_metadata.id })
      .from(artist_metadata)
      .where(eq(artist_metadata.cache_key, cacheKey))
      .limit(1);
    if (existing[0]) existingId = existing[0].id;
  }

  if (existingId) {
    // Update existing
    await db
      .update(artist_metadata)
      .set({
        ...insertData,
        created_at: undefined, // Don't update created_at
      })
      .where(eq(artist_metadata.id, existingId));
  } else {
    // Insert new
    await db.insert(artist_metadata).values(insertData);
  }
}

/**
 * Check if artist metadata exists
 */
export async function artistMetadataExists(artistId: number | null, cacheKey?: string): Promise<boolean> {
  if (artistId) {
    const result = await db
      .select({ id: artist_metadata.id })
      .from(artist_metadata)
      .where(eq(artist_metadata.artist_id, artistId))
      .limit(1);
    return result.length > 0;
  } else if (cacheKey) {
    const result = await db
      .select({ id: artist_metadata.id })
      .from(artist_metadata)
      .where(eq(artist_metadata.cache_key, cacheKey))
      .limit(1);
    return result.length > 0;
  }
  return false;
}

function rowToAlbumResult(row: AlbumMetadataRow): AlbumMetadataResult {
  return {
    discogsReleaseId: row.discogs_release_id ?? undefined,
    discogsUrl: row.discogs_url ?? undefined,
    releaseYear: row.release_year ?? undefined,
    artworkUrl: row.artwork_url ?? undefined,
    spotifyUrl: row.spotify_url ?? undefined,
    appleMusicUrl: row.apple_music_url ?? undefined,
    youtubeMusicUrl: row.youtube_music_url ?? undefined,
    bandcampUrl: row.bandcamp_url ?? undefined,
    soundcloudUrl: row.soundcloud_url ?? undefined,
  };
}

function rowToArtistResult(row: ArtistMetadataRow): ArtistMetadataResult {
  return {
    discogsArtistId: row.discogs_artist_id ?? undefined,
    bio: row.bio ?? undefined,
    wikipediaUrl: row.wikipedia_url ?? undefined,
  };
}
