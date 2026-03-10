/**
 * Search facade — routes queries to Elasticsearch or PostgreSQL pg_trgm.
 *
 * When ELASTICSEARCH_URL is set the facade tries ES first and falls back to
 * pg_trgm on any error. When the env var is unset, pg_trgm is used directly.
 */
import type { EnrichedLibraryResult } from '../requestLine/types.js';
import { enrichLibraryResult } from '../requestLine/types.js';
import { isElasticsearchEnabled } from './elasticsearch.client.js';
import {
  searchLibraryES,
  findSimilarArtistES,
  searchAlbumsByTitleES,
  searchByArtistES,
} from './elasticsearch.search.js';
import {
  pgTrgmSearchLibrary,
  pgTrgmFindSimilarArtist,
  pgTrgmSearchAlbumsByTitle,
  pgTrgmSearchByArtist,
} from '../library.service.js';

/**
 * Search the library catalog. Tries ES first when enabled, falls back to pg_trgm.
 */
export async function searchLibrary(
  query?: string,
  artist?: string,
  title?: string,
  limit = 5
): Promise<EnrichedLibraryResult[]> {
  if (isElasticsearchEnabled()) {
    try {
      const results = await searchLibraryES(query, artist, title, limit);
      return results.map((row) =>
        enrichLibraryResult({
          id: row.id,
          title: row.album_title,
          artist: row.artist_name,
          alphabeticalName: row.alphabetical_name,
          codeLetters: row.code_letters,
          codeArtistNumber: row.code_artist_number,
          codeNumber: row.code_number,
          genre: row.genre_name,
          format: row.format_name,
        })
      );
    } catch (error) {
      console.error('[Search] ES query failed, falling back to pg_trgm:', error);
    }
  }
  return pgTrgmSearchLibrary(query, artist, title, limit);
}

/**
 * Find a similar artist name. Tries ES first when enabled, falls back to pg_trgm.
 */
export async function findSimilarArtist(artistName: string, threshold = 0.85): Promise<string | null> {
  if (isElasticsearchEnabled()) {
    try {
      return await findSimilarArtistES(artistName, threshold);
    } catch (error) {
      console.error('[Search] ES findSimilarArtist failed, falling back to pg_trgm:', error);
    }
  }
  return pgTrgmFindSimilarArtist(artistName, threshold);
}

/**
 * Search for albums by title. Tries ES first when enabled, falls back to pg_trgm.
 */
export async function searchAlbumsByTitle(albumTitle: string, limit = 5): Promise<EnrichedLibraryResult[]> {
  if (isElasticsearchEnabled()) {
    try {
      const results = await searchAlbumsByTitleES(albumTitle, limit);
      return results.map((row) =>
        enrichLibraryResult({
          id: row.id,
          title: row.album_title,
          artist: row.artist_name,
          alphabeticalName: row.alphabetical_name,
          codeLetters: row.code_letters,
          codeArtistNumber: row.code_artist_number,
          codeNumber: row.code_number,
          genre: row.genre_name,
          format: row.format_name,
        })
      );
    } catch (error) {
      console.error('[Search] ES searchAlbumsByTitle failed, falling back to pg_trgm:', error);
    }
  }
  return pgTrgmSearchAlbumsByTitle(albumTitle, limit);
}

/**
 * Search the library by artist name. Tries ES first when enabled, falls back to pg_trgm.
 */
export async function searchByArtist(artistName: string, limit = 5): Promise<EnrichedLibraryResult[]> {
  if (isElasticsearchEnabled()) {
    try {
      const results = await searchByArtistES(artistName, limit);
      return results.map((row) =>
        enrichLibraryResult({
          id: row.id,
          title: row.album_title,
          artist: row.artist_name,
          alphabeticalName: row.alphabetical_name,
          codeLetters: row.code_letters,
          codeArtistNumber: row.code_artist_number,
          codeNumber: row.code_number,
          genre: row.genre_name,
          format: row.format_name,
        })
      );
    } catch (error) {
      console.error('[Search] ES searchByArtist failed, falling back to pg_trgm:', error);
    }
  }
  return pgTrgmSearchByArtist(artistName, limit);
}
