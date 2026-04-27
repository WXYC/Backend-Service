import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { ReconciledIdentity } from '@wxyc/shared/dtos';
import { RotationAddRequest } from '../controllers/library.controller.js';
import { db } from '@wxyc/database';
import {
  Artist,
  NewAlbum,
  NewAlbumFormat,
  NewArtist,
  NewGenre,
  RotationRelease,
  artists,
  genre_artist_crossreference,
  format,
  genres,
  library,
  library_artist_view,
  rotation,
  LibraryArtistViewEntry,
} from '@wxyc/database';
import { LibraryResult, EnrichedLibraryResult, enrichLibraryResult } from './requestLine/types.js';
import { extractSignificantWords } from './requestLine/matching/index.js';
import { lookupMetadata, isLmlConfigured } from './lml/lml.client.js';

/**
 * Source columns on `artists` (and any joined / view-projected row) that
 * comprise a ReconciledIdentity. Kept in sync with the @wxyc/shared schema;
 * if a new external-ID field appears on the shared type, add it here too.
 */
const RECONCILED_IDENTITY_KEYS = [
  'discogs_artist_id',
  'musicbrainz_artist_id',
  'wikidata_qid',
  'spotify_artist_id',
  'apple_music_artist_id',
  'bandcamp_id',
] as const;

type ReconciledIdentityKey = (typeof RECONCILED_IDENTITY_KEYS)[number];

/** A row that carries the six external-ID fields (artist row, view row, or any join projection). */
type ReconciledIdentitySource = {
  discogs_artist_id: number | null;
  musicbrainz_artist_id: string | null;
  wikidata_qid: string | null;
  spotify_artist_id: string | null;
  apple_music_artist_id: string | null;
  bandcamp_id: string | null;
};

/**
 * Build a shared `ReconciledIdentity` from any row carrying the six external-ID
 * fields, or null when all six are populated as null. Matching the semantic-index
 * pattern lets consumers distinguish "no IDs resolved yet" from "resolved with
 * some null IDs."
 */
export function toReconciledIdentity(row: ReconciledIdentitySource): ReconciledIdentity | null {
  const identity: ReconciledIdentity = {
    discogs_artist_id: row.discogs_artist_id,
    musicbrainz_artist_id: row.musicbrainz_artist_id,
    wikidata_qid: row.wikidata_qid,
    spotify_artist_id: row.spotify_artist_id,
    apple_music_artist_id: row.apple_music_artist_id,
    bandcamp_id: row.bandcamp_id,
  };
  if (RECONCILED_IDENTITY_KEYS.every((key) => identity[key] === null)) {
    return null;
  }
  return identity;
}

/**
 * Strip the six flat external-ID fields from a row and replace them with a
 * nested `reconciled_identity` object. Works for any shape that includes the
 * six fields (artist rows, view rows, ad-hoc join projections), so all four
 * library read endpoints can return the same wire shape.
 */
export function serializeReconciledIdentity<T extends ReconciledIdentitySource>(
  row: T
): Omit<T, ReconciledIdentityKey> & { reconciled_identity: ReconciledIdentity | null } {
  const {
    discogs_artist_id: _discogs,
    musicbrainz_artist_id: _mb,
    wikidata_qid: _qid,
    spotify_artist_id: _spotify,
    apple_music_artist_id: _apple,
    bandcamp_id: _bandcamp,
    ...rest
  } = row;
  return { ...rest, reconciled_identity: toReconciledIdentity(row) } as Omit<T, ReconciledIdentityKey> & {
    reconciled_identity: ReconciledIdentity | null;
  };
}

/**
 * Wire-format for an artist response. Replaces the six flat external-ID
 * columns with a nested `reconciled_identity` object that conforms to the
 * shared @wxyc/shared schema.
 */
export type ArtistResponse = Omit<Artist, ReconciledIdentityKey> & {
  reconciled_identity: ReconciledIdentity | null;
};

/**
 * Convert a Drizzle `artists` row to the public-facing artist response.
 * Strips the six flat external-ID columns and replaces them with a nested
 * `reconciled_identity` object.
 */
export function serializeArtist(artist: Artist): ArtistResponse {
  return serializeReconciledIdentity(artist);
}

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
  alphabetical_name: string;
  album_title: string;
  record_label: string | null;
  label_id: number | null;
  genre_name: string;
  format_name: string;
  rotation_id: number;
  add_date: Date;
  rotation_add_date: string;
  rotation_bin: 'S' | 'L' | 'M' | 'H' | 'N';
  rotation_kill_date: string | null;
  plays: number;
  reconciled_identity: ReconciledIdentity | null;
}

export const getRotationFromDB = async (): Promise<Rotation[]> => {
  const rotation_albums = await db
    .select({
      id: library.id,
      code_letters: artists.code_letters,
      code_artist_number: genre_artist_crossreference.artist_genre_code,
      code_number: library.code_number,
      artist_name: artists.artist_name,
      alphabetical_name: artists.alphabetical_name,
      album_title: library.album_title,
      record_label: library.label,
      label_id: library.label_id,
      genre_name: genres.genre_name,
      format_name: format.format_name,
      rotation_id: rotation.id,
      add_date: library.add_date,
      rotation_add_date: rotation.add_date,
      rotation_bin: rotation.rotation_bin,
      rotation_kill_date: rotation.kill_date,
      plays: library.plays,
      discogs_artist_id: artists.discogs_artist_id,
      musicbrainz_artist_id: artists.musicbrainz_artist_id,
      wikidata_qid: artists.wikidata_qid,
      spotify_artist_id: artists.spotify_artist_id,
      apple_music_artist_id: artists.apple_music_artist_id,
      bandcamp_id: artists.bandcamp_id,
    })
    .from(library)
    .innerJoin(rotation, eq(library.id, rotation.album_id))
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .innerJoin(format, eq(library.format_id, format.id))
    .innerJoin(genres, eq(library.genre_id, genres.id))
    .innerJoin(
      genre_artist_crossreference,
      and(
        eq(genre_artist_crossreference.artist_id, library.artist_id),
        eq(genre_artist_crossreference.genre_id, library.genre_id)
      )
    )
    .where(sql`${rotation.kill_date} > CURRENT_DATE OR ${rotation.kill_date} IS NULL`);

  return rotation_albums.map((row) => serializeReconciledIdentity(row));
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

export const updateOnStreaming = async (id: number, on_streaming: boolean | null) => {
  const response = await db.update(library).set({ on_streaming }).where(eq(library.id, id)).returning();
  return response[0];
};

/** Update the cached artwork URL for a library entry. */
export const updateArtworkUrl = async (id: number, artwork_url: string | null) => {
  const response = await db.update(library).set({ artwork_url }).where(eq(library.id, id)).returning();
  return response[0];
};

/**
 * Enrich search results with artwork URLs from LML.
 *
 * Results that already have artwork cached return as-is. For uncached results,
 * fetches artwork from LML in parallel via Promise.allSettled and writes back
 * to the library table (cache-through). Gracefully degrades if LML is
 * unavailable or times out.
 */
type ArtworkEnrichable = {
  id: number;
  artist_name: string;
  album_title: string;
  artwork_url: string | null | undefined;
};

export async function enrichWithArtwork<T extends ArtworkEnrichable>(results: T[]): Promise<T[]> {
  if (!isLmlConfigured()) return results;

  const uncached = results.filter((r) => r.artwork_url === null || r.artwork_url === undefined);
  if (uncached.length === 0) return results;

  const settlements = await Promise.allSettled(
    uncached.map(async (row) => {
      const lookupResult = await lookupMetadata(row.artist_name, row.album_title);
      const artworkUrl = lookupResult.results?.[0]?.artwork?.artwork_url;
      if (!artworkUrl || artworkUrl.includes('spacer.gif')) return;
      row.artwork_url = artworkUrl;
      await updateArtworkUrl(row.id, artworkUrl);
    })
  );

  for (const s of settlements) {
    if (s.status === 'rejected') {
      console.warn('[Library] Artwork enrichment failed:', s.reason);
    }
  }

  return results;
}

export const fuzzySearchLibrary = async (artist_name?: string, album_title?: string, n = 5, on_streaming?: boolean) => {
  const similarityCondition = sql`(${library_artist_view.artist_name} % ${artist_name || null} OR ${library_artist_view.album_title} % ${album_title || null})`;

  const streamingCondition =
    on_streaming !== undefined ? eq(library_artist_view.on_streaming, on_streaming) : undefined;

  const results = await db
    .select()
    .from(library_artist_view)
    .where(streamingCondition ? and(similarityCondition, streamingCondition) : similarityCondition)
    .orderBy(
      asc(sql`${library_artist_view.artist_name} <-> ${artist_name || null}`),
      asc(sql`${library_artist_view.album_title} <-> ${album_title || null}`)
    )
    .limit(n);

  return results;
};

/**
 * Public wire-format for a library_artist_view row: the six flat external-ID
 * columns are stripped and replaced with a nested `reconciled_identity`.
 */
export type LibraryArtistViewResponse = Omit<LibraryArtistViewEntry, ReconciledIdentityKey> & {
  reconciled_identity: ReconciledIdentity | null;
};

/**
 * Serialize a library_artist_view row for the wire (or any iterable of them).
 * Used at the read-endpoint boundary so the four `/library*` endpoints all
 * return the same nested-identity shape, regardless of whether they read the
 * view or join `artists` directly.
 */
export function serializeLibraryArtistViewEntry(row: LibraryArtistViewEntry): LibraryArtistViewResponse {
  return serializeReconciledIdentity(row);
}

/**
 * Look up the canonical `artist_name` for an `artists.id`. Used by addAlbum
 * (A.3) to denormalize the canonical name onto the library row so client-
 * supplied casing variants ("jessica pratt") never get persisted to library
 * out of sync with the `artists` row.
 */
export const getArtistNameById = async (artist_id: number): Promise<string | null> => {
  const response = await db
    .select({ artist_name: artists.artist_name })
    .from(artists)
    .where(eq(artists.id, artist_id))
    .limit(1);
  return response[0]?.artist_name ?? null;
};

export const artistIdFromName = async (artist_name: string, genre_id: number): Promise<number> => {
  const response = await db
    .select({ id: artists.id })
    .from(artists)
    .innerJoin(genre_artist_crossreference, eq(genre_artist_crossreference.artist_id, artists.id))
    .where(
      and(
        sql`lower(${artists.artist_name}) = lower(${artist_name})`,
        eq(genre_artist_crossreference.genre_id, genre_id)
      )
    )
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

export const insertArtistGenreCrossreference = async (
  artist_id: number,
  genre_id: number,
  artist_genre_code: number
) => {
  const response = await db
    .insert(genre_artist_crossreference)
    .values({ artist_id, genre_id, artist_genre_code })
    .returning();
  return response[0];
};

export const getArtistByCode = async (
  code_letters: string,
  genre_id: number,
  artist_genre_code: number
): Promise<{ artist_id: number; artist_name: string; code_letters: string } | null> => {
  const response = await db
    .select({
      artist_id: genre_artist_crossreference.artist_id,
      artist_name: artists.artist_name,
      code_letters: artists.code_letters,
    })
    .from(genre_artist_crossreference)
    .innerJoin(artists, eq(genre_artist_crossreference.artist_id, artists.id))
    .where(
      and(
        eq(artists.code_letters, code_letters),
        eq(genre_artist_crossreference.genre_id, genre_id),
        eq(genre_artist_crossreference.artist_genre_code, artist_genre_code)
      )
    )
    .limit(1);

  // return null if no artist found
  return response[0] ?? null;
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
    .select({ artist_genre_code: genre_artist_crossreference.artist_genre_code })
    .from(genre_artist_crossreference)
    .innerJoin(artists, eq(genre_artist_crossreference.artist_id, artists.id))
    .where(and(eq(artists.code_letters, code_letters), eq(genre_artist_crossreference.genre_id, genre_id)))
    .orderBy(desc(genre_artist_crossreference.artist_genre_code))
    .limit(1);

  // default to being first artist in the genre
  let artist_genre_code = 1;
  if (response.length) {
    artist_genre_code = response[0].artist_genre_code + 1; //otherwise we increment on the last value
  }
  return artist_genre_code;
};

export const getAlbumFromDB = async (album_id: number) => {
  const album = await db
    .select({
      id: library.id,
      code_letters: artists.code_letters,
      code_artist_number: genre_artist_crossreference.artist_genre_code,
      code_number: library.code_number,
      artist_name: artists.artist_name,
      alphabetical_name: artists.alphabetical_name,
      album_title: library.album_title,
      record_label: library.label,
      label_id: library.label_id,
      plays: library.plays,
      add_date: library.add_date,
      last_modified: library.last_modified,
      format_name: format.format_name,
      genre_name: genres.genre_name,
      date_lost: library.date_lost,
      date_found: library.date_found,
      on_streaming: library.on_streaming,
      discogs_artist_id: artists.discogs_artist_id,
      musicbrainz_artist_id: artists.musicbrainz_artist_id,
      wikidata_qid: artists.wikidata_qid,
      spotify_artist_id: artists.spotify_artist_id,
      apple_music_artist_id: artists.apple_music_artist_id,
      bandcamp_id: artists.bandcamp_id,
    })
    .from(library)
    .innerJoin(artists, eq(artists.id, library.artist_id))
    .innerJoin(format, eq(format.id, library.format_id))
    .innerJoin(genres, eq(genres.id, library.genre_id))
    .innerJoin(
      genre_artist_crossreference,
      and(
        eq(genre_artist_crossreference.artist_id, library.artist_id),
        eq(genre_artist_crossreference.genre_id, library.genre_id)
      )
    )
    .where(eq(library.id, album_id))
    .limit(1);

  if (!album[0]) return undefined;
  return serializeReconciledIdentity(album[0]);
};

export const markAlbumMissing = async (album_id: number) => {
  const result = await db
    .update(library)
    .set({ date_lost: sql`NOW()`, date_found: null, last_modified: sql`NOW()` })
    .where(eq(library.id, album_id))
    .returning({ id: library.id });
  return result[0];
};

export const markAlbumFound = async (album_id: number) => {
  const result = await db
    .update(library)
    .set({ date_found: sql`NOW()`, last_modified: sql`NOW()` })
    .where(eq(library.id, album_id))
    .returning({ id: library.id });
  return result[0];
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
    alphabeticalName: row.alphabetical_name,
    codeLetters: row.code_letters,
    codeArtistNumber: row.code_artist_number,
    codeNumber: row.code_number,
    genre: row.genre_name,
    format: row.format_name,
    onStreaming: row.on_streaming,
    reconciledIdentity: toReconciledIdentity(row),
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
  limit = 5,
  on_streaming?: boolean
): Promise<EnrichedLibraryResult[]> {
  let results: LibraryArtistViewEntry[] = [];

  if (query) {
    // Full text search using pg_trgm similarity
    results = await db
      .select()
      .from(library_artist_view)
      .where(sql`${library_artist_view.artist_name} % ${query} OR ${library_artist_view.album_title} % ${query}`)
      .orderBy(
        desc(
          sql`GREATEST(similarity(${library_artist_view.artist_name}, ${query}), similarity(${library_artist_view.album_title}, ${query}))`
        )
      )
      .limit(limit);

    // If no results with trigram, try LIKE fallback with significant words
    if (results.length === 0) {
      const words = extractSignificantWords(query);
      if (words.length > 0) {
        const conditions = words.map((w) =>
          or(ilike(library_artist_view.artist_name, `%${w}%`), ilike(library_artist_view.album_title, `%${w}%`))
        );

        results = await db
          .select()
          .from(library_artist_view)
          .where(and(...conditions))
          .limit(limit);
      }
    }
  } else if (artist || title) {
    // Filtered search by artist and/or title
    results = await fuzzySearchLibrary(artist, title, limit, on_streaming);
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
  let rows = await db
    .select()
    .from(library_artist_view)
    .where(sql`${library_artist_view.album_title} % ${albumTitle}`)
    .orderBy(desc(sql`similarity(${library_artist_view.album_title}, ${albumTitle})`))
    .limit(limit);

  // If no trigram matches, try keyword search
  if (rows.length === 0) {
    const words = extractSignificantWords(albumTitle);
    if (words.length > 0) {
      const significantWords = words.slice(0, 4);
      const conditions = significantWords.map((w) => ilike(library_artist_view.album_title, `%${w}%`));

      rows = await db
        .select()
        .from(library_artist_view)
        .where(and(...conditions))
        .limit(limit);
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
  const rows = await db
    .select()
    .from(library_artist_view)
    .where(sql`${library_artist_view.artist_name} % ${artistName}`)
    .orderBy(desc(sql`similarity(${library_artist_view.artist_name}, ${artistName})`))
    .limit(limit);

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
