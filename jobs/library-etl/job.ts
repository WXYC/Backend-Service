import { and, eq } from 'drizzle-orm';
import { isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  MirrorSQL,
  db,
  artists,
  format,
  genre_artist_crossreference,
  genres,
  library,
  cronjob_runs,
  artist_crossreference,
  artist_library_crossreference,
  compilation_track_artist,
  closeDatabaseConnection,
} from '@wxyc/database';

const legacyDB = MirrorSQL.instance();
const JOB_NAME = 'library-etl';

type LegacyReleaseRow = {
  release_id: number;
  release_title: string;
  release_last_modified: number | null;
  release_time_created: number | null;
  release_call_numbers: number | null;
  release_call_letters: string | null;
  release_alternate_artist_name: string | null;
  artist_name: string;
  artist_alpha_name: string | null;
  artist_call_letters: string | null;
  artist_call_numbers: number | null;
  genre_ref_name: string | null;
  format_ref_name: string | null;
  date_lost: number | null;
  date_found: number | null;
  release_album_artist: string | null;
  release_on_streaming: boolean | null;
};

const VARIOUS_ARTISTS_NAME = 'Various Artists';
const VARIOUS_ARTISTS_CODE_LETTERS = 'V/A';
const VARIOUS_ARTISTS_CODE_NUMBER = 0;

const parseTabRow = (line: string, columnCount: number) => {
  const columns = line.split('\t');
  if (columns.length !== columnCount) {
    return null;
  }
  return columns;
};

const toNullableString = (value?: string) => {
  if (value == null || value.trim().length === 0) return null;
  return value.trim();
};

const toNullableNumber = (value?: string) => {
  if (value == null || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isDbOnlyGenre = (genreRef?: string | null) => {
  return genreRef != null && genreRef.trim().toLowerCase() === 'db_only';
};

const normalizeArtistName = (name: string) => {
  const trimmed = name.trim();
  if (/^various\s*artists\s*-rock\s*-[a-z]$/i.test(trimmed)) {
    return { name: trimmed, isVarious: false };
  }
  if (/^various(?:\s+artists(?:\s*-\s*[a-z]+)?)?$/i.test(trimmed)) {
    return { name: VARIOUS_ARTISTS_NAME, isVarious: true };
  }
  return { name: trimmed, isVarious: false };
};

/**
 * Derive alphabetical sort name (e.g. "The Beatles" -> "Beatles, The").
 * Uses legacy value when provided and non-empty.
 */
const toAlphabeticalName = (artistName: string, fromLegacy?: string | null): string => {
  const legacy = fromLegacy?.trim();
  if (legacy && legacy.length > 0) return legacy;
  // This shouldn't be necessary, but just in case since alphabetical_name is not nullable in database
  const match = artistName.trim().match(/^The\s+(.+)$/i);
  return match ? `${match[1]}, The` : artistName.trim();
};

const normalizeCodeLetters = (code: string | null) => {
  if (!code) return null;
  const trimmed = code.trim();
  if (trimmed.length === 0) return null;
  if (/Z-[A-Z]/.test(trimmed)) {
    return VARIOUS_ARTISTS_CODE_LETTERS;
  }
  if (trimmed.length === 3) {
    return trimmed.toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
};

const parseFormatAndDiscs = (formatText: string) => {
  const normalized = formatText.toLowerCase().trim();

  const matchCd = normalized.match(/^cd(?:\s*x\s*(\d+))?(?:\s*box)?$/);
  if (matchCd) {
    const discQuantity = matchCd[1] ? Number(matchCd[1]) : 1;
    return { formatName: 'cd', discQuantity };
  }

  const matchCdr = normalized.match(/^cdr$/);
  if (matchCdr) {
    return { formatName: 'cdr', discQuantity: 1 };
  }

  if (!normalized.startsWith('vinyl')) {
    return null;
  }

  const xMatch = normalized.match(/\bx\s*(\d+)\b/);
  const discQuantity = xMatch && Number.isFinite(Number(xMatch[1])) ? Number(xMatch[1]) : 1;

  let formatName = 'vinyl';
  if (normalized.includes('7"')) {
    formatName = 'vinyl 7"';
  } else if (normalized.includes('10"')) {
    formatName = 'vinyl 10"';
  } else if (normalized.includes('12"') || normalized.includes('lp')) {
    formatName = 'vinyl 12"';
  }

  return { formatName, discQuantity };
};

const toDateOrUndefined = (value: number | null) => {
  if (value == null) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
};

const toDateOnlyString = (value: number | null) => {
  const date = toDateOrUndefined(value);
  if (!date) return undefined;
  return date.toISOString().slice(0, 10);
};

/**
 * Parse tab-delimited output from `SELECT ID, REFERENCE_NAME FROM GENRE`.
 * Filters out `db_only` and rows with empty names.
 */
const parseLegacyGenreRows = (raw: string): string[] => {
  if (raw.trim().length === 0) return [];
  const results: string[] = [];
  for (const line of raw.trim().split('\n')) {
    const columns = parseTabRow(line, 2);
    if (!columns) {
      console.warn('[library-etl] Skipping malformed legacy genre row:', line);
      continue;
    }
    const name = columns[1].trim();
    if (name.length === 0) continue;
    if (isDbOnlyGenre(name)) continue;
    results.push(name);
  }
  return results;
};

/**
 * Parse tab-delimited output from `SELECT ID, REFERENCE_NAME FROM FORMAT`.
 * Normalizes each to a canonical format name via `parseFormatAndDiscs` and deduplicates.
 */
const parseLegacyFormatRows = (raw: string): string[] => {
  if (raw.trim().length === 0) return [];
  const seen = new Set<string>();
  const results: string[] = [];
  for (const line of raw.trim().split('\n')) {
    const columns = parseTabRow(line, 2);
    if (!columns) {
      console.warn('[library-etl] Skipping malformed legacy format row:', line);
      continue;
    }
    const parsed = parseFormatAndDiscs(columns[1]);
    if (!parsed) continue;
    if (seen.has(parsed.formatName)) continue;
    seen.add(parsed.formatName);
    results.push(parsed.formatName);
  }
  return results;
};

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbClient = typeof db | DbTransaction;

const getLastRunTimestamp = async (jobName: string): Promise<number | null> => {
  const response = await db
    .select({ lastRun: cronjob_runs.last_run })
    .from(cronjob_runs)
    .where(eq(cronjob_runs.job_name, jobName))
    .limit(1);

  const lastRun = response[0]?.lastRun ?? null;
  return lastRun ? lastRun.getTime() : null;
};

const fetchLegacyGenres = async () => {
  const raw = await legacyDB.send('SELECT ID, REFERENCE_NAME FROM GENRE;');
  return parseLegacyGenreRows(raw);
};

const fetchLegacyFormats = async () => {
  const raw = await legacyDB.send('SELECT ID, REFERENCE_NAME FROM FORMAT;');
  return parseLegacyFormatRows(raw);
};

/**
 * Insert genres that don't already exist in PostgreSQL.
 * Existing records are unchanged (insert-only, no updates).
 */
const syncGenres = async (tx: DbTransaction, legacyGenreNames: string[]) => {
  const existingRows = await tx.select().from(genres);
  const existingNames = new Set(existingRows.map((r) => r.genre_name.toLowerCase()));
  let inserted = 0;
  for (const name of legacyGenreNames) {
    if (existingNames.has(name.toLowerCase())) continue;
    await tx.insert(genres).values({ genre_name: name });
    existingNames.add(name.toLowerCase());
    inserted++;
  }
  return inserted;
};

/**
 * Insert formats that don't already exist in PostgreSQL.
 * Existing records are unchanged (insert-only, no updates).
 */
const syncFormats = async (tx: DbTransaction, canonicalFormatNames: string[]) => {
  const existingRows = await tx.select().from(format);
  const existingNames = new Set(existingRows.map((r) => r.format_name.toLowerCase()));
  let inserted = 0;
  for (const name of canonicalFormatNames) {
    if (existingNames.has(name.toLowerCase())) continue;
    await tx.insert(format).values({ format_name: name });
    existingNames.add(name.toLowerCase());
    inserted++;
  }
  return inserted;
};

const updateLastRun = async (dbClient: DbClient, jobName: string, lastRun: Date) => {
  await dbClient
    .insert(cronjob_runs)
    .values({ job_name: jobName, last_run: lastRun })
    .onConflictDoUpdate({
      target: cronjob_runs.job_name,
      set: { last_run: lastRun },
    });
};

const buildReleaseQuery = (
  lastRunMs: number | null,
  includeDateLostFound: boolean,
  includeAlbumArtist: boolean,
  includeOnStreaming: boolean = false
) => {
  const lastRunFilter = lastRunMs == null ? '' : `WHERE lr.TIME_LAST_MODIFIED > ${lastRunMs}`;
  const dateLostFoundColumns = includeDateLostFound ? `,\n      lr.DATE_LOST,\n      lr.DATE_FOUND` : '';
  const albumArtistColumn = includeAlbumArtist
    ? `,\n      REPLACE(REPLACE(IFNULL(lr.ALBUM_ARTIST, ''), '\\t', ' '), '\\n', ' ')`
    : '';
  const onStreamingColumn = includeOnStreaming ? `,\n      lr.ON_STREAMING` : '';
  return `
    SELECT
      lr.ID,
      REPLACE(REPLACE(IFNULL(lr.TITLE, ''), '\\t', ' '), '\\n', ' '),
      lr.TIME_LAST_MODIFIED,
      lr.TIME_CREATED,
      lr.CALL_NUMBERS AS release_call_numbers,
      lr.CALL_LETTERS AS release_call_letters,
      REPLACE(REPLACE(IFNULL(lr.ALTERNATE_ARTIST_NAME, ''), '\\t', ' '), '\\n', ' '),
      REPLACE(REPLACE(IFNULL(lc.PRESENTATION_NAME, ''), '\\t', ' '), '\\n', ' '),
      REPLACE(REPLACE(IFNULL(lc.ALPHABETICAL_NAME, ''), '\\t', ' '), '\\n', ' '),
      lc.CALL_LETTERS AS artist_call_letters,
      lc.CALL_NUMBERS AS artist_call_numbers,
      g.REFERENCE_NAME,
      f.REFERENCE_NAME${dateLostFoundColumns}${albumArtistColumn}${onStreamingColumn}
    FROM LIBRARY_RELEASE lr
    JOIN LIBRARY_CODE lc ON lr.LIBRARY_CODE_ID = lc.ID
    JOIN GENRE g ON lc.GENRE_ID = g.ID
    JOIN FORMAT f ON lr.FORMAT_ID = f.ID
    ${lastRunFilter}
    ORDER BY lr.TIME_LAST_MODIFIED ASC;
  `;
};

const parseOnStreaming = (value?: string): boolean | null => {
  if (value == null || value.trim().length === 0 || value.trim() === 'NULL') return null;
  return value.trim() === '1';
};

const parseReleaseRows = (raw: string, columnCount: number): LegacyReleaseRow[] => {
  const rows = raw.trim().length === 0 ? [] : raw.trim().split('\n');
  const parsed: LegacyReleaseRow[] = [];

  for (const line of rows) {
    const columns = parseTabRow(line, columnCount);
    if (!columns) {
      console.warn('[library-etl] Skipping malformed legacy row:', line);
      continue;
    }

    parsed.push({
      release_id: Number(columns[0]),
      release_title: columns[1],
      release_last_modified: toNullableNumber(columns[2]),
      release_time_created: toNullableNumber(columns[3]),
      release_call_numbers: toNullableNumber(columns[4]),
      release_call_letters: toNullableString(columns[5]),
      release_alternate_artist_name: toNullableString(columns[6]),
      artist_name: columns[7],
      artist_alpha_name: toNullableString(columns[8]),
      artist_call_letters: toNullableString(columns[9]),
      artist_call_numbers: toNullableNumber(columns[10]),
      genre_ref_name: toNullableString(columns[11]),
      format_ref_name: toNullableString(columns[12]),
      date_lost: columnCount >= 15 ? toNullableNumber(columns[13]) : null,
      date_found: columnCount >= 15 ? toNullableNumber(columns[14]) : null,
      release_album_artist: columnCount >= 16 ? toNullableString(columns[15]) : null,
      release_on_streaming: columnCount >= 17 ? parseOnStreaming(columns[16]) : null,
    });
  }

  return parsed;
};

const fetchLegacyReleases = async (lastRunMs: number | null) => {
  // Try with ON_STREAMING + DATE_LOST/DATE_FOUND + ALBUM_ARTIST columns first; fall back progressively
  try {
    const raw = await legacyDB.send(buildReleaseQuery(lastRunMs, true, true, true));
    return parseReleaseRows(raw, 17);
  } catch {
    console.warn('[library-etl] ON_STREAMING column not available, falling back to 16-column query.');
  }
  try {
    const raw = await legacyDB.send(buildReleaseQuery(lastRunMs, true, true));
    return parseReleaseRows(raw, 16);
  } catch {
    console.warn('[library-etl] ALBUM_ARTIST column not available, falling back to 15-column query.');
  }
  try {
    const raw = await legacyDB.send(buildReleaseQuery(lastRunMs, true, false));
    return parseReleaseRows(raw, 15);
  } catch {
    console.warn('[library-etl] DATE_LOST/DATE_FOUND columns not available, falling back to 13-column query.');
    const raw = await legacyDB.send(buildReleaseQuery(lastRunMs, false, false));
    return parseReleaseRows(raw, 13);
  }
};

const ensureArtist = async (
  dbClient: DbClient,
  artistName: string,
  alphabeticalName: string,
  isVarious: boolean,
  genreId: number,
  codeLetters: string | null,
  artistGenreCode: number,
  artistCache: Map<string, number>,
  addDate?: string,
  lastModified?: Date
) => {
  const normalizedLetters = codeLetters ?? '??';
  const artistKey = isVarious
    ? `${artistName.toLowerCase()}|${normalizedLetters}`
    : `${artistName.toLowerCase()}|${normalizedLetters}|${genreId}|${artistGenreCode}`;
  const cached = artistCache.get(artistKey);
  if (cached) return cached;

  const nameLower = artistName.toLowerCase().trim();
  const lettersLower = normalizedLetters.toLowerCase().trim();
  const query = isVarious
    ? dbClient
        .select({ id: artists.id })
        .from(artists)
        .where(
          and(sql`lower(${artists.artist_name}) = ${nameLower}`, sql`lower(${artists.code_letters}) = ${lettersLower}`)
        )
        .limit(1)
    : dbClient
        .select({ id: artists.id })
        .from(artists)
        .innerJoin(genre_artist_crossreference, eq(genre_artist_crossreference.artist_id, artists.id))
        .where(
          and(
            sql`lower(${artists.artist_name}) = ${nameLower}`,
            sql`lower(${artists.code_letters}) = ${lettersLower}`,
            eq(genre_artist_crossreference.genre_id, genreId),
            eq(genre_artist_crossreference.artist_genre_code, artistGenreCode)
          )
        )
        .limit(1);

  const existing = await query;
  if (existing.length) {
    artistCache.set(artistKey, existing[0].id);
    return existing[0].id;
  }

  const inserted = await dbClient
    .insert(artists)
    .values({
      artist_name: artistName,
      alphabetical_name: alphabeticalName,
      code_letters: normalizedLetters,
      add_date: addDate,
      last_modified: lastModified,
    })
    .returning();

  const id = inserted[0]?.id;
  if (!id) {
    throw new Error(`[library-etl] Failed to insert artist ${artistName}.`);
  }
  artistCache.set(artistKey, id);
  return id;
};

const ensureGenreArtistCrossref = async (
  dbClient: DbClient,
  artistId: number,
  genreId: number,
  artistGenreCode: number
) => {
  await dbClient
    .insert(genre_artist_crossreference)
    .values({ artist_id: artistId, genre_id: genreId, artist_genre_code: artistGenreCode })
    .onConflictDoUpdate({
      target: [genre_artist_crossreference.artist_id, genre_artist_crossreference.genre_id],
      set: { artist_genre_code: artistGenreCode },
    });
};

/**
 * Build a cache key for artist lookups.
 * Used to deduplicate artist resolution across cross-reference imports.
 */
const buildArtistCacheKey = (artistName: string, codeLetters: string): string =>
  `${artistName.toLowerCase().trim()}|${codeLetters.toLowerCase().trim()}`;

/**
 * Build a cache key for album lookups.
 * Used to deduplicate album resolution across release cross-reference imports.
 */
const buildAlbumCacheKey = (artistId: number, genreId: number, albumTitle: string, codeNumber: number): string =>
  `${artistId}|${genreId}|${albumTitle.toLowerCase().trim()}|${codeNumber}`;

/**
 * Find an existing artist by name and code letters (read-only, no insert).
 * Uses artistIdCache for deduplication across cross-reference imports.
 */
const findArtistId = async (
  dbClient: DbClient,
  artistName: string,
  codeLetters: string,
  artistIdCache: Map<string, number>
): Promise<number | null> => {
  const key = buildArtistCacheKey(artistName, codeLetters);
  const cached = artistIdCache.get(key);
  if (cached !== undefined) return cached;

  const rows = await dbClient
    .select({ id: artists.id })
    .from(artists)
    .where(
      and(
        sql`lower(${artists.artist_name}) = ${artistName.toLowerCase().trim()}`,
        sql`lower(${artists.code_letters}) = ${codeLetters.toLowerCase().trim()}`
      )
    )
    .limit(1);

  if (rows.length === 0) return null;
  artistIdCache.set(key, rows[0].id);
  return rows[0].id;
};

/**
 * Find an existing album by artist, genre, title, and code number (read-only).
 * Uses albumIdCache for deduplication.
 */
const findAlbumId = async (
  dbClient: DbClient,
  artistId: number,
  genreId: number,
  albumTitle: string,
  codeNumber: number | null,
  albumIdCache: Map<string, number>
): Promise<number | null> => {
  const resolvedCode = codeNumber ?? 0;
  const key = buildAlbumCacheKey(artistId, genreId, albumTitle, resolvedCode);
  const cached = albumIdCache.get(key);
  if (cached !== undefined) return cached;

  const rows = await dbClient
    .select({ id: library.id })
    .from(library)
    .where(
      and(
        eq(library.artist_id, artistId),
        eq(library.genre_id, genreId),
        eq(library.album_title, albumTitle),
        eq(library.code_number, resolvedCode)
      )
    )
    .limit(1);

  if (rows.length === 0) return null;
  albumIdCache.set(key, rows[0].id);
  return rows[0].id;
};

type LegacyCrossrefRow = {
  sourceArtistName: string;
  sourceCodeLetters: string;
  targetArtistName: string;
  targetCodeLetters: string;
  comment: string | null;
};

type LegacyReleaseCrossrefRow = {
  artistName: string;
  artistCodeLetters: string;
  albumTitle: string;
  albumCodeNumber: number;
  genreName: string;
  comment: string | null;
};

/**
 * Fetch artist-to-artist cross-references (aliases, side projects, related artists)
 * from tubafrenzy's LIBRARY_CODE_CROSS_REFERENCE table.
 */
const fetchLegacyArtistCrossRefs = async (): Promise<LegacyCrossrefRow[]> => {
  const sqlQuery = `
    SELECT
      REPLACE(REPLACE(src.PRESENTATION_NAME, '\\t', ' '), '\\n', ' '),
      src.CALL_LETTERS,
      REPLACE(REPLACE(tgt.PRESENTATION_NAME, '\\t', ' '), '\\n', ' '),
      tgt.CALL_LETTERS,
      REPLACE(REPLACE(IFNULL(cr.COMMENT, ''), '\\t', ' '), '\\n', ' ')
    FROM LIBRARY_CODE_CROSS_REFERENCE cr
    JOIN LIBRARY_CODE src ON cr.CROSS_REFERENCING_ARTIST_ID = src.ID
    JOIN LIBRARY_CODE tgt ON cr.CROSS_REFERENCED_LIBRARY_CODE_ID = tgt.ID;
  `;
  const raw = await legacyDB.send(sqlQuery);
  if (raw.trim().length === 0) return [];

  const rows: LegacyCrossrefRow[] = [];
  for (const line of raw.trim().split('\n')) {
    const columns = parseTabRow(line, 5);
    if (!columns) {
      console.warn('[library-etl] Skipping malformed artist crossref row:', line);
      continue;
    }
    rows.push({
      sourceArtistName: columns[0].trim(),
      sourceCodeLetters: columns[1].trim(),
      targetArtistName: columns[2].trim(),
      targetCodeLetters: columns[3].trim(),
      comment: toNullableString(columns[4]),
    });
  }
  return rows;
};

/**
 * Fetch release cross-references (guest appearances, collaborations)
 * from tubafrenzy's RELEASE_CROSS_REFERENCE table.
 */
const fetchLegacyReleaseCrossRefs = async (): Promise<LegacyReleaseCrossrefRow[]> => {
  const sqlQuery = `
    SELECT
      REPLACE(REPLACE(lc.PRESENTATION_NAME, '\\t', ' '), '\\n', ' '),
      lc.CALL_LETTERS,
      REPLACE(REPLACE(lr.TITLE, '\\t', ' '), '\\n', ' '),
      lr.CALL_NUMBERS,
      g.REFERENCE_NAME,
      REPLACE(REPLACE(IFNULL(cr.COMMENT, ''), '\\t', ' '), '\\n', ' ')
    FROM RELEASE_CROSS_REFERENCE cr
    JOIN LIBRARY_RELEASE lr ON cr.CROSS_REFERENCED_RELEASE_ID = lr.ID
    JOIN LIBRARY_CODE lc ON cr.CROSS_REFERENCING_ARTIST_ID = lc.ID
    JOIN GENRE g ON lc.GENRE_ID = g.ID;
  `;
  const raw = await legacyDB.send(sqlQuery);
  if (raw.trim().length === 0) return [];

  const rows: LegacyReleaseCrossrefRow[] = [];
  for (const line of raw.trim().split('\n')) {
    const columns = parseTabRow(line, 6);
    if (!columns) {
      console.warn('[library-etl] Skipping malformed release crossref row:', line);
      continue;
    }
    rows.push({
      artistName: columns[0].trim(),
      artistCodeLetters: columns[1].trim(),
      albumTitle: columns[2].trim(),
      albumCodeNumber: Number(columns[3]) || 0,
      genreName: columns[4].trim(),
      comment: toNullableString(columns[5]),
    });
  }
  return rows;
};

/**
 * Import artist-to-artist cross-references into the artist_crossreference table.
 * Uses ON CONFLICT DO NOTHING for idempotent upserts.
 */
const importArtistCrossRefs = async (
  tx: DbTransaction,
  rows: LegacyCrossrefRow[],
  artistIdCache: Map<string, number>
): Promise<{ imported: number; skipped: number }> => {
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    const sourceId = await findArtistId(tx, row.sourceArtistName, row.sourceCodeLetters, artistIdCache);
    const targetId = await findArtistId(tx, row.targetArtistName, row.targetCodeLetters, artistIdCache);

    if (!sourceId || !targetId) {
      skipped++;
      continue;
    }

    await tx
      .insert(artist_crossreference)
      .values({
        source_artist_id: sourceId,
        target_artist_id: targetId,
        comment: row.comment,
      })
      .onConflictDoUpdate({
        target: [artist_crossreference.source_artist_id, artist_crossreference.target_artist_id],
        set: { comment: sql`excluded.comment` },
      });

    imported++;
  }

  return { imported, skipped };
};

type LegacyCompilationTrackRow = {
  libraryReleaseId: number;
  artistName: string;
  trackTitle: string | null;
  trackPosition: string | null;
};

/**
 * Parse tab-delimited output from COMPILATION_TRACK_ARTIST query.
 */
const parseLegacyCompilationTrackRows = (raw: string): LegacyCompilationTrackRow[] => {
  if (raw.trim().length === 0) return [];
  const results: LegacyCompilationTrackRow[] = [];
  for (const line of raw.trim().split('\n')) {
    const columns = parseTabRow(line, 4);
    if (!columns) {
      console.warn('[library-etl] Skipping malformed compilation track row:', line);
      continue;
    }
    const artistName = columns[1].trim();
    if (artistName.length === 0) continue;
    results.push({
      libraryReleaseId: Number(columns[0]),
      artistName,
      trackTitle: toNullableString(columns[2]),
      trackPosition: toNullableString(columns[3]),
    });
  }
  return results;
};

const fetchLegacyCompilationTracks = async (): Promise<LegacyCompilationTrackRow[]> => {
  try {
    const raw = await legacyDB.send(`
      SELECT
        LIBRARY_RELEASE_ID,
        REPLACE(REPLACE(ARTIST_NAME, '\\t', ' '), '\\n', ' '),
        REPLACE(REPLACE(IFNULL(TRACK_TITLE, ''), '\\t', ' '), '\\n', ' '),
        REPLACE(REPLACE(IFNULL(TRACK_POSITION, ''), '\\t', ' '), '\\n', ' ')
      FROM COMPILATION_TRACK_ARTIST;
    `);
    return parseLegacyCompilationTrackRows(raw);
  } catch {
    console.warn('[library-etl] COMPILATION_TRACK_ARTIST table not available, skipping.');
    return [];
  }
};

const importCompilationTracks = async (
  tx: DbTransaction,
  rows: LegacyCompilationTrackRow[]
): Promise<{ imported: number; skipped: number }> => {
  // Build map of legacy_release_id -> library.id
  const releaseRows = await tx
    .select({ id: library.id, legacyReleaseId: library.legacy_release_id })
    .from(library)
    .where(sql`${library.legacy_release_id} IS NOT NULL`);
  const releaseMap = new Map<number, number>();
  for (const row of releaseRows) {
    if (row.legacyReleaseId != null) {
      releaseMap.set(row.legacyReleaseId, row.id);
    }
  }

  let imported = 0;
  let skipped = 0;
  for (const row of rows) {
    const libraryId = releaseMap.get(row.libraryReleaseId);
    if (!libraryId) {
      skipped++;
      continue;
    }

    await tx
      .insert(compilation_track_artist)
      .values({
        library_id: libraryId,
        artist_name: row.artistName,
        track_title: row.trackTitle,
        track_position: row.trackPosition,
      })
      .onConflictDoNothing();
    imported++;
  }

  return { imported, skipped };
};

/**
 * Import release cross-references (artist→album links) into the artist_library_crossreference table.
 * Uses ON CONFLICT DO NOTHING for idempotent upserts.
 */
const importReleaseCrossRefs = async (
  tx: DbTransaction,
  rows: LegacyReleaseCrossrefRow[],
  artistIdCache: Map<string, number>,
  albumIdCache: Map<string, number>,
  genreMap: Map<string, number>
): Promise<{ imported: number; skipped: number }> => {
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    const artistId = await findArtistId(tx, row.artistName, row.artistCodeLetters, artistIdCache);
    if (!artistId) {
      skipped++;
      continue;
    }

    const genreId = genreMap.get(row.genreName.toLowerCase());
    if (!genreId) {
      skipped++;
      continue;
    }

    const albumId = await findAlbumId(tx, artistId, genreId, row.albumTitle, row.albumCodeNumber, albumIdCache);
    if (!albumId) {
      skipped++;
      continue;
    }

    await tx
      .insert(artist_library_crossreference)
      .values({
        artist_id: artistId,
        library_id: albumId,
        comment: row.comment,
      })
      .onConflictDoUpdate({
        target: [artist_library_crossreference.artist_id, artist_library_crossreference.library_id],
        set: { comment: sql`excluded.comment` },
      });

    imported++;
  }

  return { imported, skipped };
};

type ExistingRelease = {
  id: number;
  legacyReleaseId: number | null;
  dateLost: Date | null;
  dateFound: Date | null;
  albumArtist: string | null;
  onStreaming: boolean | null;
};

const findExistingRelease = async (
  dbClient: DbClient,
  artistId: number,
  genreId: number,
  albumTitle: string,
  codeNumber: number | null,
  codeVolumeLetters: string | null
): Promise<ExistingRelease | null> => {
  const response = await dbClient
    .select({
      id: library.id,
      legacyReleaseId: library.legacy_release_id,
      dateLost: library.date_lost,
      dateFound: library.date_found,
      albumArtist: library.album_artist,
      onStreaming: library.on_streaming,
    })
    .from(library)
    .where(
      and(
        eq(library.artist_id, artistId),
        eq(library.genre_id, genreId),
        eq(library.album_title, albumTitle),
        eq(library.code_number, codeNumber ?? 0),
        codeVolumeLetters ? eq(library.code_volume_letters, codeVolumeLetters) : isNull(library.code_volume_letters)
      )
    )
    .limit(1);

  return response.length > 0 ? response[0] : null;
};

const run = async () => {
  try {
    const runStartedAt = new Date();
    const lastRunMs = await getLastRunTimestamp(JOB_NAME);
    const legacyReleases = await fetchLegacyReleases(lastRunMs);

    if (legacyReleases.length === 0) {
      console.log('[library-etl] No new legacy releases found.');
      await updateLastRun(db, JOB_NAME, runStartedAt);
      return;
    }

    let insertedCount = 0;
    let skippedCount = 0;

    await db.transaction(async (tx) => {
      // Sync genres and formats from legacy database before processing releases
      const legacyGenreNames = await fetchLegacyGenres();
      const canonicalFormatNames = await fetchLegacyFormats();
      const genresInserted = await syncGenres(tx, legacyGenreNames);
      const formatsInserted = await syncFormats(tx, canonicalFormatNames);
      if (genresInserted > 0 || formatsInserted > 0) {
        console.log(
          `[library-etl] Synced ${genresInserted} new genre(s), ${formatsInserted} new format(s) from legacy database.`
        );
      }

      const genreRows = await tx.select().from(genres);
      const genreMap = new Map(genreRows.map((genre) => [genre.genre_name.toLowerCase(), genre.id]));

      const formatRows = await tx.select().from(format);
      const formatMap = new Map(formatRows.map((row) => [row.format_name.toLowerCase(), row.id]));

      const artistCache = new Map<string, number>();

      for (const release of legacyReleases) {
        if (isDbOnlyGenre(release.genre_ref_name)) {
          skippedCount += 1;
          continue;
        }

        const genreName = release.genre_ref_name ?? '';
        const genreId = genreMap.get(genreName.toLowerCase());
        if (!genreId) {
          console.warn(`[library-etl] Missing genre "${genreName}" for release ${release.release_id}.`);
          skippedCount += 1;
          continue;
        }

        const formatText = release.format_ref_name ?? '';
        const formatParsed = parseFormatAndDiscs(formatText);
        if (!formatParsed) {
          console.warn(`[library-etl] Unsupported format "${formatText}" for release ${release.release_id}.`);
          skippedCount += 1;
          continue;
        }

        const formatId = formatMap.get(formatParsed.formatName.toLowerCase()) ?? null;
        if (!formatId) {
          console.warn(`[library-etl] Missing format "${formatParsed.formatName}" for release ${release.release_id}.`);
          skippedCount += 1;
          continue;
        }

        const artistInfo = normalizeArtistName(release.artist_name);
        if (artistInfo.name.length === 0) {
          skippedCount += 1;
          continue;
        }
        const alphabeticalName = toAlphabeticalName(artistInfo.name, release.artist_alpha_name);
        const codeLetters = artistInfo.isVarious
          ? VARIOUS_ARTISTS_CODE_LETTERS
          : normalizeCodeLetters(release.artist_call_letters);
        const artistGenreCode = artistInfo.isVarious ? VARIOUS_ARTISTS_CODE_NUMBER : (release.artist_call_numbers ?? 0);

        const artistId = await ensureArtist(
          tx,
          artistInfo.name,
          alphabeticalName,
          artistInfo.isVarious,
          genreId,
          codeLetters,
          artistGenreCode,
          artistCache,
          toDateOnlyString(release.release_time_created),
          toDateOrUndefined(release.release_last_modified)
        );

        await ensureGenreArtistCrossref(tx, artistId, genreId, artistGenreCode);

        const albumTitle = release.release_title.trim();
        if (albumTitle.length === 0) {
          skippedCount += 1;
          continue;
        }

        const codeVolumeLetters =
          release.release_call_letters != null && release.release_call_letters.trim().length > 0
            ? release.release_call_letters.trim()
            : null;
        const existing = await findExistingRelease(
          tx,
          artistId,
          genreId,
          albumTitle,
          release.release_call_numbers,
          codeVolumeLetters
        );
        if (existing) {
          // Backfill legacy_release_id and update date_lost/date_found if changed
          const updates: Record<string, unknown> = {};
          if (existing.legacyReleaseId == null) {
            updates.legacy_release_id = release.release_id;
          }
          const newDateLost = toDateOrUndefined(release.date_lost) ?? null;
          const newDateFound = toDateOrUndefined(release.date_found) ?? null;
          if (existing.dateLost?.getTime() !== newDateLost?.getTime()) {
            updates.date_lost = newDateLost;
          }
          if (existing.dateFound?.getTime() !== newDateFound?.getTime()) {
            updates.date_found = newDateFound;
          }
          const newAlbumArtist = release.release_album_artist ?? null;
          if ((existing.albumArtist ?? null) !== newAlbumArtist) {
            updates.album_artist = newAlbumArtist;
          }
          const newOnStreaming = release.release_on_streaming ?? null;
          if ((existing.onStreaming ?? null) !== newOnStreaming) {
            updates.on_streaming = newOnStreaming;
          }
          if (Object.keys(updates).length > 0) {
            await tx.update(library).set(updates).where(eq(library.id, existing.id));
          }
          skippedCount += 1;
          continue;
        }

        await tx.insert(library).values({
          artist_id: artistId,
          genre_id: genreId,
          format_id: formatId,
          alternate_artist_name: release.release_alternate_artist_name,
          album_artist: release.release_album_artist,
          album_title: albumTitle,
          code_number: release.release_call_numbers ?? 0,
          code_volume_letters: codeVolumeLetters,
          disc_quantity: formatParsed.discQuantity,
          legacy_release_id: release.release_id,
          add_date: toDateOrUndefined(release.release_time_created),
          last_modified: toDateOrUndefined(release.release_last_modified),
          date_lost: toDateOrUndefined(release.date_lost),
          date_found: toDateOrUndefined(release.date_found),
          on_streaming: release.release_on_streaming,
        });

        insertedCount += 1;
      }

      // --- Cross-reference imports ---
      // Detect if this is the first run by checking if both crossref tables are empty.
      // If so, do a full backfill regardless of last_run timestamp.
      const artistCrossrefCount = await tx.select({ count: sql<number>`count(*)::int` }).from(artist_crossreference);
      const releaseCrossrefCount = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(artist_library_crossreference);
      const isFirstCrossrefRun = artistCrossrefCount[0].count === 0 && releaseCrossrefCount[0].count === 0;

      if (isFirstCrossrefRun) {
        console.log('[library-etl] Cross-reference tables are empty — running full backfill.');
      }

      // Build shared caches for cross-reference resolution
      const artistIdCache = new Map<string, number>();
      const albumIdCache = new Map<string, number>();

      // Import artist-to-artist cross-references
      const legacyArtistCrossRefs = await fetchLegacyArtistCrossRefs();
      const artistCrossResult = await importArtistCrossRefs(tx, legacyArtistCrossRefs, artistIdCache);
      if (artistCrossResult.imported > 0 || artistCrossResult.skipped > 0) {
        console.log(
          `[library-etl] Artist cross-references: imported ${artistCrossResult.imported}, skipped ${artistCrossResult.skipped}.`
        );
      }

      // Import release cross-references (artist→album links)
      const legacyReleaseCrossRefs = await fetchLegacyReleaseCrossRefs();
      const releaseCrossResult = await importReleaseCrossRefs(
        tx,
        legacyReleaseCrossRefs,
        artistIdCache,
        albumIdCache,
        genreMap
      );
      if (releaseCrossResult.imported > 0 || releaseCrossResult.skipped > 0) {
        console.log(
          `[library-etl] Release cross-references: imported ${releaseCrossResult.imported}, skipped ${releaseCrossResult.skipped}.`
        );
      }

      // Import compilation track artists (V/A releases)
      const legacyCTA = await fetchLegacyCompilationTracks();
      if (legacyCTA.length > 0) {
        const ctaResult = await importCompilationTracks(tx, legacyCTA);
        console.log(
          `[library-etl] Compilation track artists: imported ${ctaResult.imported}, skipped ${ctaResult.skipped}.`
        );
      }

      await updateLastRun(tx, JOB_NAME, runStartedAt);
    });

    console.log(`[library-etl] Completed. Inserted ${insertedCount}, skipped ${skippedCount}.`);
  } finally {
    await closeDatabaseConnection();
    legacyDB.close();
  }
};

// Exported for unit testing
export {
  parseTabRow,
  toNullableString,
  toNullableNumber,
  isDbOnlyGenre,
  normalizeArtistName,
  toAlphabeticalName,
  normalizeCodeLetters,
  parseFormatAndDiscs,
  toDateOrUndefined,
  toDateOnlyString,
  parseLegacyGenreRows,
  parseLegacyFormatRows,
  parseLegacyCompilationTrackRows,
  parseReleaseRows,
  buildArtistCacheKey,
  buildAlbumCacheKey,
};

run().catch((error) => {
  console.error('[library-etl] Failed:', error);
  process.exitCode = 1;
});
