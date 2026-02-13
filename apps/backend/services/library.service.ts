import { desc, eq, sql } from 'drizzle-orm';
import { RotationAddRequest } from '../controllers/library.controller.js';
import { db } from '@wxyc/database';
import {
  NewAlbum,
  NewAlbumFormat,
  NewArtist,
  NewGenre,
  RotationRelease,
  artists,
  format,
  genres,
  library,
  library_artist_view,
  rotation,
  LibraryArtistViewEntry,
} from '@wxyc/database';
import { LibraryResult, EnrichedLibraryResult, enrichLibraryResult } from './requestLine/types.js';
import { extractSignificantWords } from './requestLine/matching/index.js';

export const getFormatsFromDB = async () => {
  const formats = await db
    .select()
    .from(format)
    .where(sql`true`);
  return formats;
};

export const insertFormat = async (new_format: NewAlbumFormat) => {
  const response = await db.insert(format).values(new_format).returning();
  return response[0];
};

export interface Rotation {
  id: number;
  code_letters: string;
  code_artist_number: number;
  code_number: number;
  artist_name: string;
  album_title: string;
  record_label: string | null;
  genre_name: string;
  format_name: string;
  rotation_id: number;
  add_date: Date;
  rotation_add_date: string;
  rotation_bin: 'S' | 'L' | 'M' | 'H';
  rotation_kill_date: string | null;
  plays: number;
}

export const getRotationFromDB = async (): Promise<Rotation[]> => {
  const rotation_albums = await db
    .select({
      id: library.id,
      code_letters: artists.code_letters,
      code_artist_number: artists.code_artist_number,
      code_number: library.code_number,
      artist_name: artists.artist_name,
      album_title: library.album_title,
      record_label: library.label,
      genre_name: genres.genre_name,
      format_name: format.format_name,
      rotation_id: rotation.id,
      add_date: library.add_date,
      rotation_add_date: rotation.add_date,
      rotation_bin: rotation.rotation_bin,
      rotation_kill_date: rotation.kill_date,
      plays: library.plays,
    })
    .from(library)
    .innerJoin(rotation, eq(library.id, rotation.album_id))
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .innerJoin(genres, eq(artists.genre_id, genres.id))
    .innerJoin(format, eq(library.format_id, format.id))
    .where(sql`${rotation.kill_date} > CURRENT_DATE OR ${rotation.kill_date} IS NULL`);

  return rotation_albums;
};

export const addToRotation = async (newRotation: RotationAddRequest) => {
  const insertedRotation: RotationRelease[] = await db.insert(rotation).values(newRotation).returning();
  return insertedRotation[0];
};

export const killRotationInDB = async (rotationId: number, updatedKillDate?: string) => {
  const updatedRotation = await db
    .update(rotation)
    .set({ kill_date: updatedKillDate || sql`CURRENT_DATE` })
    .where(eq(rotation.id, rotationId))
    .returning();
  return updatedRotation[0];
};

export const insertAlbum = async (newAlbum: NewAlbum) => {
  const response = await db.insert(library).values(newAlbum).returning();
  return response[0];
};

//based on artist name and album title, retrieve n best matches from db
//let's build the query using drizzle's sql object
export const fuzzySearchLibrary = async (artist_name?: string, album_title?: string, n = 5) => {
  const query = sql`SELECT *,
                    ${library_artist_view.artist_name} <-> ${artist_name || null} AS artist_dist,
                    ${library_artist_view.album_title} <-> ${album_title || null} AS album_dist
                      FROM ${library_artist_view}
                      WHERE ${library_artist_view.artist_name} % ${artist_name || null} OR
                            ${library_artist_view.album_title} % ${album_title || null}
                      ORDER BY artist_dist asc, album_dist asc
                      LIMIT ${n}`;

  const response = await db.execute(query);
  return response;

  // trying to get something like this working, but having type issues using orderBy method with 2 computed columns
  // maybe at some point for more type safety 🤷

  // const query1 = db
  //   .select({
  //     library_id: library_artist_view.library_id,
  //     album_title: library_artist_view.album_title,
  //     artist_name: library_artist_view.artist_name,
  //     artist_similarity: sql`similarity(${library_artist_view.artist_name}, ${artist_name || ''})`,
  //     album_similarity: sql`similarity(${library_artist_view.album_title}, ${album_title || ''})`,
  //   })
  //   .from(library_artist_view)
  //   .where(
  //     sql`${library_artist_view.album_title} % ${album_title} OR ${library_artist_view.artist_name} % ${artist_name}`
  //   )
  //   .orderBy(
  //     ({ album_similarity }) =>
  //       desc(
  //         album_similarity
  //       ) /*, ({ artist_similarity, album_similarity }) => {desc(artist_similarity), desc(album_similarity)}*/
  //   )
  //   .limit(n)
  //   .toSQL();
  // console.log(query1);
};

export const artistIdFromName = async (artist_name: string, genre_id: number): Promise<number> => {
  const response = await db
    .select({ id: artists.id })
    .from(artists)
    .where(sql`lower(${artists.artist_name}) = lower(${artist_name}) AND ${artists.genre_id} = ${genre_id}`)
    .limit(1);

  if (!response.length) {
    return 0;
  } else {
    return response[0].id;
  }
};

export const insertArtist = async (new_artist: NewArtist) => {
  const response = await db.insert(artists).values(new_artist).returning();
  return response[0];
};

export const generateAlbumCodeNumber = async (artist_id: number): Promise<number> => {
  const response = await db
    .select({ code_number: library.code_number })
    .from(library)
    .where(eq(library.artist_id, artist_id))
    .orderBy(desc(library.code_number))
    .limit(1);
  //in case this is the first album
  let code_number = 1;
  if (response.length) {
    code_number = response[0].code_number + 1; //otherwise we increment on the last value
  }
  return code_number;
};

export const generateArtistNumber = async (code_letters: string, genre_id: number): Promise<number> => {
  const response = await db
    .select({ code_artist_number: artists.code_artist_number })
    .from(artists)
    .where(sql`${artists.code_letters} = ${code_letters} AND ${artists.genre_id} = ${genre_id}`)
    .orderBy(desc(artists.code_artist_number))
    .limit(1);

  let code_artist_number = 1;
  if (response.length) {
    code_artist_number = response[0].code_artist_number + 1; //otherwise we increment on the last value
  }
  return code_artist_number;
};

export const getAlbumFromDB = async (album_id: number) => {
  const album = await db
    .select({
      id: library.id,
      code_letters: artists.code_letters,
      code_artist_number: artists.code_letters,
      code_number: library.code_number,
      artist_name: artists.artist_name,
      album_title: library.album_title,
      record_label: library.label,
      plays: library.plays,
      add_date: library.add_date,
      last_modified: library.last_modified,
    })
    .from(library)
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .where(eq(library.id, album_id))
    .limit(1);

  return album[0];
};

export const getGenresFromDB = async () => {
  const genreCollection = await db.select().from(genres);
  return genreCollection;
};

export const insertGenre = async (genre: NewGenre) => {
  const response = await db.insert(genres).values(genre).returning();
  return response[0];
};

export const isISODate = (date: string): boolean => {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  return date.match(regex) !== null;
};

// =============================================================================
// Request Line Enhanced Search Functions
// =============================================================================

/**
 * Convert a library_artist_view row to LibraryResult.
 */
function viewRowToLibraryResult(row: LibraryArtistViewEntry): LibraryResult {
  return {
    id: row.id,
    title: row.album_title,
    artist: row.artist_name,
    codeLetters: row.code_letters,
    codeArtistNumber: row.code_artist_number,
    codeNumber: row.code_number,
    genre: row.genre_name,
    format: row.format_name,
  };
}

/**
 * Search the library catalog with flexible query options.
 *
 * Uses PostgreSQL pg_trgm for fuzzy matching. Supports:
 * - Combined artist + album/song queries
 * - Artist-only queries
 * - Album/title-only queries
 *
 * @param query - Free text search query (artist and/or album)
 * @param artist - Artist name filter
 * @param title - Album/title filter
 * @param limit - Maximum results to return
 * @returns Array of enriched library results
 */
export async function searchLibrary(
  query?: string,
  artist?: string,
  title?: string,
  limit = 5
): Promise<EnrichedLibraryResult[]> {
  let results: LibraryArtistViewEntry[] = [];

  if (query) {
    // Full text search using pg_trgm similarity
    const searchQuery = sql`
      SELECT *,
        similarity(${library_artist_view.artist_name}, ${query}) as artist_sim,
        similarity(${library_artist_view.album_title}, ${query}) as album_sim
      FROM ${library_artist_view}
      WHERE ${library_artist_view.artist_name} % ${query}
         OR ${library_artist_view.album_title} % ${query}
      ORDER BY GREATEST(
        similarity(${library_artist_view.artist_name}, ${query}),
        similarity(${library_artist_view.album_title}, ${query})
      ) DESC
      LIMIT ${limit}
    `;

    const response = await db.execute(searchQuery);
    results = response as unknown as LibraryArtistViewEntry[];

    // If no results with trigram, try LIKE fallback with significant words
    if (results.length === 0) {
      const words = extractSignificantWords(query);
      if (words.length > 0) {
        // Build LIKE conditions for each word
        const likeConditions = words
          .map((w) => `(artist_name ILIKE '%${w}%' OR album_title ILIKE '%${w}%')`)
          .join(' AND ');

        const fallbackQuery = sql.raw(`
          SELECT * FROM wxyc_schema.library_artist_view
          WHERE ${likeConditions}
          LIMIT ${limit}
        `);

        const fallbackResponse = await db.execute(fallbackQuery);
        results = fallbackResponse as unknown as LibraryArtistViewEntry[];
      }
    }
  } else if (artist || title) {
    // Filtered search by artist and/or title
    const response = await fuzzySearchLibrary(artist, title, limit);
    results = response as unknown as LibraryArtistViewEntry[];
  }

  return results.map((row) => enrichLibraryResult(viewRowToLibraryResult(row)));
}

/**
 * Find a similar artist name in the library using fuzzy matching.
 *
 * Useful for correcting typos or spelling variants (e.g., "Color" vs "Colour").
 *
 * @param artistName - Artist name to match
 * @param threshold - Minimum similarity score (0.0 to 1.0) to accept
 * @returns Corrected artist name if a good match is found, null otherwise
 */
export async function findSimilarArtist(artistName: string, threshold = 0.85): Promise<string | null> {
  // Use pg_trgm similarity function to find close matches
  const query = sql`
    SELECT DISTINCT artist_name,
      similarity(artist_name, ${artistName}) as sim
    FROM ${library_artist_view}
    WHERE similarity(artist_name, ${artistName}) > ${threshold}
    ORDER BY sim DESC
    LIMIT 1
  `;

  const response = await db.execute(query);
  const rows = response as unknown as Array<{ artist_name: string; sim: number }>;

  if (rows.length > 0) {
    const match = rows[0];
    // Only return if it's actually different (i.e., a correction)
    if (match.artist_name.toLowerCase() !== artistName.toLowerCase()) {
      console.log(
        `[Library] Corrected artist '${artistName}' to '${match.artist_name}' (similarity: ${match.sim.toFixed(2)})`
      );
      return match.artist_name;
    }
  }

  return null;
}

/**
 * Search for albums by title with fuzzy matching.
 *
 * Useful for cross-referencing Discogs album titles with the library.
 *
 * @param albumTitle - Album title to search for
 * @param limit - Maximum results to return
 * @returns Array of enriched library results
 */
export async function searchAlbumsByTitle(albumTitle: string, limit = 5): Promise<EnrichedLibraryResult[]> {
  const query = sql`
    SELECT *,
      similarity(${library_artist_view.album_title}, ${albumTitle}) as sim
    FROM ${library_artist_view}
    WHERE ${library_artist_view.album_title} % ${albumTitle}
    ORDER BY sim DESC
    LIMIT ${limit}
  `;

  const response = await db.execute(query);
  const rows = response as unknown as LibraryArtistViewEntry[];

  // If no trigram matches, try keyword search
  if (rows.length === 0) {
    const words = extractSignificantWords(albumTitle);
    if (words.length > 0) {
      const significantWords = words.slice(0, 4); // Use up to 4 significant words
      const likeConditions = significantWords.map((w) => `album_title ILIKE '%${w}%'`).join(' AND ');

      const fallbackQuery = sql.raw(`
        SELECT * FROM wxyc_schema.library_artist_view
        WHERE ${likeConditions}
        LIMIT ${limit}
      `);

      const fallbackResponse = await db.execute(fallbackQuery);
      return (fallbackResponse as unknown as LibraryArtistViewEntry[]).map((row) =>
        enrichLibraryResult(viewRowToLibraryResult(row))
      );
    }
  }

  return rows.map((row) => enrichLibraryResult(viewRowToLibraryResult(row)));
}

/**
 * Search the library for releases by a specific artist.
 *
 * @param artistName - Artist name to search for
 * @param limit - Maximum results to return
 * @returns Array of enriched library results
 */
export async function searchByArtist(artistName: string, limit = 5): Promise<EnrichedLibraryResult[]> {
  const query = sql`
    SELECT *,
      similarity(${library_artist_view.artist_name}, ${artistName}) as sim
    FROM ${library_artist_view}
    WHERE ${library_artist_view.artist_name} % ${artistName}
    ORDER BY sim DESC
    LIMIT ${limit}
  `;

  const response = await db.execute(query);
  const rows = response as unknown as LibraryArtistViewEntry[];

  return rows.map((row) => enrichLibraryResult(viewRowToLibraryResult(row)));
}

/**
 * Filter library results to only include those matching the artist.
 *
 * Requires the searched artist name to appear at the START of the result's
 * artist field (case-insensitive). This prevents false positives like
 * "Toy" matching "Chew Toy" while still allowing "Various" to match
 * "Various Artists - Rock - D".
 *
 * @param results - List of library items from search
 * @param artist - Artist name to filter by
 * @returns Filtered list containing only items where artist matches
 */
export function filterResultsByArtist(
  results: EnrichedLibraryResult[],
  artist: string | null | undefined
): EnrichedLibraryResult[] {
  if (!artist) {
    return results;
  }

  const artistLower = artist.toLowerCase();
  const filtered = results.filter((item) => {
    const itemArtist = (item.artist || '').toLowerCase();
    // Check if result's artist starts with searched artist
    return itemArtist.startsWith(artistLower);
  });

  if (filtered.length < results.length) {
    console.log(`[Library] Filtered ${results.length} results to ${filtered.length} matching artist '${artist}'`);
  }

  return filtered;
}
