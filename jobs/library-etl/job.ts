import { and, eq, sql } from 'drizzle-orm';
import { isNull } from 'drizzle-orm';
import {
  MirrorSQL,
  db,
  artists,
  artist_crossreference,
  artist_library_crossreference,
  format,
  genre_artist_crossreference,
  genres,
  library,
  cronjob_runs,
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
};

type LegacyArtistCrossRefRow = {
  source_artist_name: string;
  source_code_letters: string | null;
  source_code_numbers: number | null;
  source_genre_ref: string | null;
  target_artist_name: string;
  target_code_letters: string | null;
  target_code_numbers: number | null;
  target_genre_ref: string | null;
  comment: string | null;
};

type LegacyReleaseCrossRefRow = {
  source_artist_name: string;
  source_code_letters: string | null;
  source_code_numbers: number | null;
  source_genre_ref: string | null;
  release_title: string;
  release_call_numbers: number | null;
  release_call_letters: string | null;
  target_artist_name: string;
  target_code_letters: string | null;
  target_code_numbers: number | null;
  target_genre_ref: string | null;
  comment: string | null;
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

const buildArtistCacheKey = (
  artistName: string,
  isVarious: boolean,
  codeLetters: string | null,
  genreId: number,
  artistGenreCode: number
): string => {
  const normalizedLetters = codeLetters ?? '??';
  return isVarious
    ? `${artistName.toLowerCase()}|${normalizedLetters}`
    : `${artistName.toLowerCase()}|${normalizedLetters}|${genreId}|${artistGenreCode}`;
};

const buildAlbumCacheKey = (
  artistId: number,
  genreId: number,
  albumTitle: string,
  codeNumber: number | null,
  codeVolumeLetters: string | null
): string => {
  return `${artistId}|${genreId}|${albumTitle}|${codeNumber ?? 0}|${codeVolumeLetters ?? ''}`;
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

const updateLastRun = async (dbClient: DbClient, jobName: string, lastRun: Date) => {
  await dbClient
    .insert(cronjob_runs)
    .values({ job_name: jobName, last_run: lastRun })
    .onConflictDoUpdate({
      target: cronjob_runs.job_name,
      set: { last_run: lastRun },
    });
};

const fetchLegacyReleases = async (lastRunMs: number | null) => {
  const lastRunFilter = lastRunMs == null ? '' : `WHERE lr.TIME_LAST_MODIFIED > ${lastRunMs}`;
  const sqlQuery = `
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
      f.REFERENCE_NAME
    FROM LIBRARY_RELEASE lr
    JOIN LIBRARY_CODE lc ON lr.LIBRARY_CODE_ID = lc.ID
    JOIN GENRE g ON lc.GENRE_ID = g.ID
    JOIN FORMAT f ON lr.FORMAT_ID = f.ID
    ${lastRunFilter}
    ORDER BY lr.TIME_LAST_MODIFIED ASC;
  `;

  const raw = await legacyDB.send(sqlQuery);
  const rows = raw.trim().length === 0 ? [] : raw.trim().split('\n');
  const columnCount = 13;
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
    });
  }

  return parsed;
};

const fetchLegacyArtistCrossRefs = async (lastRunMs: number | null) => {
  const lastRunFilter = lastRunMs == null ? '' : `WHERE lccr.TIME_LAST_MODIFIED > ${lastRunMs}`;
  const sqlQuery = `
    SELECT
      REPLACE(REPLACE(IFNULL(src.PRESENTATION_NAME, ''), '\\t', ' '), '\\n', ' '),
      src.CALL_LETTERS,
      src.CALL_NUMBERS,
      src_g.REFERENCE_NAME,
      REPLACE(REPLACE(IFNULL(tgt.PRESENTATION_NAME, ''), '\\t', ' '), '\\n', ' '),
      tgt.CALL_LETTERS,
      tgt.CALL_NUMBERS,
      tgt_g.REFERENCE_NAME,
      REPLACE(REPLACE(IFNULL(lccr.COMMENT, ''), '\\t', ' '), '\\n', ' ')
    FROM LIBRARY_CODE_CROSS_REFERENCE lccr
    JOIN LIBRARY_CODE src ON lccr.CROSS_REFERENCING_ARTIST_ID = src.ID
    JOIN GENRE src_g ON src.GENRE_ID = src_g.ID
    JOIN LIBRARY_CODE tgt ON lccr.CROSS_REFERENCED_LIBRARY_CODE_ID = tgt.ID
    JOIN GENRE tgt_g ON tgt.GENRE_ID = tgt_g.ID
    ${lastRunFilter}
    ORDER BY lccr.TIME_LAST_MODIFIED ASC;
  `;

  const raw = await legacyDB.send(sqlQuery);
  const rows = raw.trim().length === 0 ? [] : raw.trim().split('\n');
  const columnCount = 9;
  const parsed: LegacyArtistCrossRefRow[] = [];

  for (const line of rows) {
    const columns = parseTabRow(line, columnCount);
    if (!columns) {
      console.warn('[library-etl] Skipping malformed artist crossref row:', line);
      continue;
    }

    parsed.push({
      source_artist_name: columns[0],
      source_code_letters: toNullableString(columns[1]),
      source_code_numbers: toNullableNumber(columns[2]),
      source_genre_ref: toNullableString(columns[3]),
      target_artist_name: columns[4],
      target_code_letters: toNullableString(columns[5]),
      target_code_numbers: toNullableNumber(columns[6]),
      target_genre_ref: toNullableString(columns[7]),
      comment: toNullableString(columns[8]),
    });
  }

  return parsed;
};

const fetchLegacyReleaseCrossRefs = async (lastRunMs: number | null) => {
  const lastRunFilter = lastRunMs == null ? '' : `WHERE rcr.TIME_LAST_MODIFIED > ${lastRunMs}`;
  const sqlQuery = `
    SELECT
      REPLACE(REPLACE(IFNULL(src.PRESENTATION_NAME, ''), '\\t', ' '), '\\n', ' '),
      src.CALL_LETTERS,
      src.CALL_NUMBERS,
      src_g.REFERENCE_NAME,
      REPLACE(REPLACE(IFNULL(lr.TITLE, ''), '\\t', ' '), '\\n', ' '),
      lr.CALL_NUMBERS,
      lr.CALL_LETTERS,
      REPLACE(REPLACE(IFNULL(tgt.PRESENTATION_NAME, ''), '\\t', ' '), '\\n', ' '),
      tgt.CALL_LETTERS,
      tgt.CALL_NUMBERS,
      tgt_g.REFERENCE_NAME,
      REPLACE(REPLACE(IFNULL(rcr.COMMENT, ''), '\\t', ' '), '\\n', ' ')
    FROM RELEASE_CROSS_REFERENCE rcr
    JOIN LIBRARY_CODE src ON rcr.CROSS_REFERENCING_ARTIST_ID = src.ID
    JOIN GENRE src_g ON src.GENRE_ID = src_g.ID
    JOIN LIBRARY_RELEASE lr ON rcr.CROSS_REFERENCED_RELEASE_ID = lr.ID
    JOIN LIBRARY_CODE tgt ON lr.LIBRARY_CODE_ID = tgt.ID
    JOIN GENRE tgt_g ON tgt.GENRE_ID = tgt_g.ID
    ${lastRunFilter}
    ORDER BY rcr.TIME_LAST_MODIFIED ASC;
  `;

  const raw = await legacyDB.send(sqlQuery);
  const rows = raw.trim().length === 0 ? [] : raw.trim().split('\n');
  const columnCount = 12;
  const parsed: LegacyReleaseCrossRefRow[] = [];

  for (const line of rows) {
    const columns = parseTabRow(line, columnCount);
    if (!columns) {
      console.warn('[library-etl] Skipping malformed release crossref row:', line);
      continue;
    }

    parsed.push({
      source_artist_name: columns[0],
      source_code_letters: toNullableString(columns[1]),
      source_code_numbers: toNullableNumber(columns[2]),
      source_genre_ref: toNullableString(columns[3]),
      release_title: columns[4],
      release_call_numbers: toNullableNumber(columns[5]),
      release_call_letters: toNullableString(columns[6]),
      target_artist_name: columns[7],
      target_code_letters: toNullableString(columns[8]),
      target_code_numbers: toNullableNumber(columns[9]),
      target_genre_ref: toNullableString(columns[10]),
      comment: toNullableString(columns[11]),
    });
  }

  return parsed;
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
  const artistKey = buildArtistCacheKey(artistName, isVarious, codeLetters, genreId, artistGenreCode);
  const cached = artistCache.get(artistKey);
  if (cached) return cached;

  const normalizedLetters = codeLetters ?? '??';

  const query = isVarious
    ? dbClient
        .select({ id: artists.id })
        .from(artists)
        .where(and(eq(artists.artist_name, artistName), eq(artists.code_letters, normalizedLetters)))
        .limit(1)
    : dbClient
        .select({ id: artists.id })
        .from(artists)
        .innerJoin(genre_artist_crossreference, eq(genre_artist_crossreference.artist_id, artists.id))
        .where(
          and(
            eq(artists.artist_name, artistName),
            eq(artists.code_letters, normalizedLetters),
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

/**
 * Find an artist ID by the same composite key used by ensureArtist, without inserting.
 * Checks the in-memory cache first, then falls back to a DB query.
 * Populates the cache on DB hit to avoid repeated queries.
 */
const findArtistId = async (
  dbClient: DbClient,
  artistName: string,
  isVarious: boolean,
  genreId: number,
  codeLetters: string | null,
  artistGenreCode: number,
  artistCache: Map<string, number>
): Promise<number | null> => {
  const artistKey = buildArtistCacheKey(artistName, isVarious, codeLetters, genreId, artistGenreCode);
  const cached = artistCache.get(artistKey);
  if (cached) return cached;

  const normalizedLetters = codeLetters ?? '??';

  const query = isVarious
    ? dbClient
        .select({ id: artists.id })
        .from(artists)
        .where(and(eq(artists.artist_name, artistName), eq(artists.code_letters, normalizedLetters)))
        .limit(1)
    : dbClient
        .select({ id: artists.id })
        .from(artists)
        .innerJoin(genre_artist_crossreference, eq(genre_artist_crossreference.artist_id, artists.id))
        .where(
          and(
            eq(artists.artist_name, artistName),
            eq(artists.code_letters, normalizedLetters),
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

  return null;
};

const ensureGenreArtistCrossref = async (
  dbClient: DbClient,
  artistId: number,
  genreId: number,
  artistGenreCode: number
) => {
  const existing = await dbClient
    .select({ artist_id: genre_artist_crossreference.artist_id })
    .from(genre_artist_crossreference)
    .where(and(eq(genre_artist_crossreference.artist_id, artistId), eq(genre_artist_crossreference.genre_id, genreId)))
    .limit(1);

  if (existing.length) return;

  await dbClient.insert(genre_artist_crossreference).values({
    artist_id: artistId,
    genre_id: genreId,
    artist_genre_code: artistGenreCode,
  });
};

const findAlbumId = async (
  dbClient: DbClient,
  artistId: number,
  genreId: number,
  albumTitle: string,
  codeNumber: number | null,
  codeVolumeLetters: string | null
): Promise<number | null> => {
  const response = await dbClient
    .select({ id: library.id })
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

  return response.length > 0 ? response[0].id : null;
};

/**
 * Resolve artist fields from a cross-reference row into a Backend-Service artist ID.
 * Applies the same normalization as the release import loop.
 */
const resolveArtistId = async (
  dbClient: DbClient,
  artistName: string,
  codeLettersRaw: string | null,
  codeNumbers: number | null,
  genreRef: string | null,
  genreMap: Map<string, number>,
  artistCache: Map<string, number>
): Promise<number | null> => {
  const artistInfo = normalizeArtistName(artistName);
  if (artistInfo.name.length === 0) return null;

  if (isDbOnlyGenre(genreRef)) return null;

  const genreName = genreRef ?? '';
  const genreId = genreMap.get(genreName.toLowerCase());
  if (!genreId) return null;

  const codeLetters = artistInfo.isVarious ? VARIOUS_ARTISTS_CODE_LETTERS : normalizeCodeLetters(codeLettersRaw);
  const artistGenreCode = artistInfo.isVarious ? VARIOUS_ARTISTS_CODE_NUMBER : (codeNumbers ?? 0);

  return findArtistId(
    dbClient,
    artistInfo.name,
    artistInfo.isVarious,
    genreId,
    codeLetters,
    artistGenreCode,
    artistCache
  );
};

/**
 * Check if a cross-reference table is empty (for one-time backfill detection).
 */
const isTableEmpty = async (
  dbClient: DbClient,
  table: typeof artist_crossreference | typeof artist_library_crossreference
): Promise<boolean> => {
  const result = await dbClient
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .limit(1);
  return (result[0]?.count ?? 0) === 0;
};

const run = async () => {
  try {
    const runStartedAt = new Date();
    const lastRunMs = await getLastRunTimestamp(JOB_NAME);
    const legacyReleases = await fetchLegacyReleases(lastRunMs);

    if (legacyReleases.length === 0) {
      console.log('[library-etl] No new legacy releases found.');
    }

    let insertedCount = 0;
    let skippedCount = 0;
    let artistXrefInserted = 0;
    let artistXrefSkipped = 0;
    let releaseXrefInserted = 0;
    let releaseXrefSkipped = 0;

    await db.transaction(async (tx) => {
      const genreRows = await tx.select().from(genres);
      const genreMap = new Map(genreRows.map((genre) => [genre.genre_name.toLowerCase(), genre.id]));

      const formatRows = await tx.select().from(format);
      const formatMap = new Map(formatRows.map((row) => [row.format_name.toLowerCase(), row.id]));

      const artistCache = new Map<string, number>();
      const albumIdCache = new Map<string, number>();

      // Phase 1: Import releases
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
        const existingAlbumId = await findAlbumId(
          tx,
          artistId,
          genreId,
          albumTitle,
          release.release_call_numbers,
          codeVolumeLetters
        );
        if (existingAlbumId != null) {
          albumIdCache.set(
            buildAlbumCacheKey(artistId, genreId, albumTitle, release.release_call_numbers, codeVolumeLetters),
            existingAlbumId
          );
          skippedCount += 1;
          continue;
        }

        const inserted = await tx
          .insert(library)
          .values({
            artist_id: artistId,
            genre_id: genreId,
            format_id: formatId,
            alternate_artist_name: release.release_alternate_artist_name,
            album_title: albumTitle,
            code_number: release.release_call_numbers ?? 0,
            code_volume_letters: codeVolumeLetters,
            disc_quantity: formatParsed.discQuantity,
            add_date: toDateOrUndefined(release.release_time_created),
            last_modified: toDateOrUndefined(release.release_last_modified),
          })
          .returning({ id: library.id });

        if (inserted[0]?.id) {
          albumIdCache.set(
            buildAlbumCacheKey(artistId, genreId, albumTitle, release.release_call_numbers, codeVolumeLetters),
            inserted[0].id
          );
        }

        insertedCount += 1;
      }

      // Phase 2: Import artist cross-references (artist ↔ artist)
      // On first run, do a full fetch (backfill); subsequent runs are incremental
      const artistXrefEmpty = await isTableEmpty(tx, artist_crossreference);
      const artistXrefLastRun = artistXrefEmpty ? null : lastRunMs;
      const artistCrossRefs = await fetchLegacyArtistCrossRefs(artistXrefLastRun);

      for (const xref of artistCrossRefs) {
        const sourceId = await resolveArtistId(
          tx,
          xref.source_artist_name,
          xref.source_code_letters,
          xref.source_code_numbers,
          xref.source_genre_ref,
          genreMap,
          artistCache
        );
        const targetId = await resolveArtistId(
          tx,
          xref.target_artist_name,
          xref.target_code_letters,
          xref.target_code_numbers,
          xref.target_genre_ref,
          genreMap,
          artistCache
        );

        if (sourceId == null || targetId == null) {
          artistXrefSkipped++;
          continue;
        }

        await tx
          .insert(artist_crossreference)
          .values({
            source_artist_id: sourceId,
            target_artist_id: targetId,
            comment: xref.comment,
          })
          .onConflictDoNothing();

        artistXrefInserted++;
      }

      // Phase 3: Import release cross-references (artist → album)
      const releaseXrefEmpty = await isTableEmpty(tx, artist_library_crossreference);
      const releaseXrefLastRun = releaseXrefEmpty ? null : lastRunMs;
      const releaseCrossRefs = await fetchLegacyReleaseCrossRefs(releaseXrefLastRun);

      for (const xref of releaseCrossRefs) {
        const sourceId = await resolveArtistId(
          tx,
          xref.source_artist_name,
          xref.source_code_letters,
          xref.source_code_numbers,
          xref.source_genre_ref,
          genreMap,
          artistCache
        );
        if (sourceId == null) {
          releaseXrefSkipped++;
          continue;
        }

        // Resolve target album: find the owning artist, then find the album
        const targetArtistId = await resolveArtistId(
          tx,
          xref.target_artist_name,
          xref.target_code_letters,
          xref.target_code_numbers,
          xref.target_genre_ref,
          genreMap,
          artistCache
        );
        if (targetArtistId == null) {
          releaseXrefSkipped++;
          continue;
        }

        const targetGenreName = xref.target_genre_ref ?? '';
        const targetGenreId = genreMap.get(targetGenreName.toLowerCase());
        if (!targetGenreId) {
          releaseXrefSkipped++;
          continue;
        }

        const releaseTitle = xref.release_title.trim();
        const releaseCvl =
          xref.release_call_letters != null && xref.release_call_letters.trim().length > 0
            ? xref.release_call_letters.trim()
            : null;

        // Check album cache first
        const albumCacheKey = buildAlbumCacheKey(
          targetArtistId,
          targetGenreId,
          releaseTitle,
          xref.release_call_numbers,
          releaseCvl
        );
        let targetAlbumId = albumIdCache.get(albumCacheKey) ?? null;

        if (targetAlbumId == null) {
          targetAlbumId = await findAlbumId(
            tx,
            targetArtistId,
            targetGenreId,
            releaseTitle,
            xref.release_call_numbers,
            releaseCvl
          );
          if (targetAlbumId != null) {
            albumIdCache.set(albumCacheKey, targetAlbumId);
          }
        }

        if (targetAlbumId == null) {
          releaseXrefSkipped++;
          continue;
        }

        await tx
          .insert(artist_library_crossreference)
          .values({
            artist_id: sourceId,
            library_id: targetAlbumId,
            comment: xref.comment,
          })
          .onConflictDoNothing();

        releaseXrefInserted++;
      }

      await updateLastRun(tx, JOB_NAME, runStartedAt);
    });

    const parts = [`Inserted ${insertedCount} releases, skipped ${skippedCount}`];
    if (artistXrefInserted > 0 || artistXrefSkipped > 0) {
      parts.push(`Artist xrefs: ${artistXrefInserted} inserted, ${artistXrefSkipped} skipped`);
    }
    if (releaseXrefInserted > 0 || releaseXrefSkipped > 0) {
      parts.push(`Release xrefs: ${releaseXrefInserted} inserted, ${releaseXrefSkipped} skipped`);
    }
    console.log(`[library-etl] Completed. ${parts.join('. ')}.`);
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
  buildAlbumCacheKey,
  buildArtistCacheKey,
};

run().catch((error) => {
  console.error('[library-etl] Failed:', error);
  process.exitCode = 1;
});
