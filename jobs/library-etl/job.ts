import { and, eq } from 'drizzle-orm';
import { isNull } from 'drizzle-orm';
import {
  MirrorSQL,
  db,
  artists,
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
  if (/^various\s+artists\s*-\s*/i.test(trimmed)) {
    return { name: VARIOUS_ARTISTS_NAME, isVarious: true };
  }
  return { name: trimmed, isVarious: false };
};

const normalizeCodeLetters = (code: string | null) => {
  if (!code) return null;
  const trimmed = code.trim();
  if (trimmed.length === 0) return null;
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

const ensureArtist = async (
  dbClient: DbClient,
  artistName: string,
  isVarious: boolean,
  genreId: number,
  codeLetters: string | null,
  codeArtistNumber: number | null,
  artistCache: Map<string, number>,
  addDate?: string,
  lastModified?: Date
) => {
  const normalizedLetters = codeLetters ?? '??';
  const normalizedNumber = codeArtistNumber ?? 0;
  const artistKey = `${artistName.toLowerCase()}|${normalizedLetters}|${normalizedNumber}`;
  const cached = artistCache.get(artistKey);
  if (cached) return cached;

  const baseConditions = [
    eq(artists.artist_name, artistName),
    eq(artists.code_letters, normalizedLetters),
    eq(artists.code_artist_number, normalizedNumber),
  ];

  const query = dbClient
    .select({ id: artists.id })
    .from(artists)
    .where(isVarious ? and(...baseConditions) : and(...baseConditions, eq(artists.genre_id, genreId)))
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
      genre_id: genreId,
      code_letters: normalizedLetters,
      code_artist_number: normalizedNumber,
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

const albumExists = async (
  dbClient: DbClient,
  artistId: number,
  genreId: number,
  albumTitle: string,
  codeNumber: number | null,
  codeVolumeLetters: string | null
) => {
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

  return response.length > 0;
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
        const codeLetters = artistInfo.isVarious
          ? VARIOUS_ARTISTS_CODE_LETTERS
          : normalizeCodeLetters(release.artist_call_letters);
        const codeArtistNumber = artistInfo.isVarious
          ? VARIOUS_ARTISTS_CODE_NUMBER
          : (release.artist_call_numbers ?? 0);

        const artistId = await ensureArtist(
          tx,
          artistInfo.name,
          artistInfo.isVarious,
          genreId,
          codeLetters,
          codeArtistNumber,
          artistCache,
          toDateOnlyString(release.release_time_created),
          toDateOrUndefined(release.release_last_modified)
        );

        await ensureGenreArtistCrossref(
          tx,
          artistId,
          genreId,
          artistInfo.isVarious ? VARIOUS_ARTISTS_CODE_NUMBER : (release.artist_call_numbers ?? 0)
        );

        const albumTitle = release.release_title.trim();
        if (albumTitle.length === 0) {
          skippedCount += 1;
          continue;
        }

        const codeVolumeLetters =
          release.release_call_letters != null && release.release_call_letters.trim().length > 0
            ? release.release_call_letters.trim()
            : null;
        const alreadyExists = await albumExists(
          tx,
          artistId,
          genreId,
          albumTitle,
          release.release_call_numbers,
          codeVolumeLetters
        );
        if (alreadyExists) {
          skippedCount += 1;
          continue;
        }

        await tx.insert(library).values({
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
        });

        insertedCount += 1;
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
  normalizeCodeLetters,
  parseFormatAndDiscs,
  toDateOrUndefined,
  toDateOnlyString,
};

run().catch((error) => {
  console.error('[library-etl] Failed:', error);
  process.exitCode = 1;
});
