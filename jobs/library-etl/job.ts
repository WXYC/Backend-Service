import { and, eq, inArray } from 'drizzle-orm';
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
  library_delete_denylist,
  cronjob_runs,
  artist_crossreference,
  artist_library_crossreference,
  compilation_track_artist,
  closeDatabaseConnection,
} from '@wxyc/database';

const legacyDB = MirrorSQL.instance();
const JOB_NAME = 'library-etl';

/**
 * Per-import watermarks for the secondary imports (BS#2424).
 *
 * The job-wide `library-etl` row cannot be reused as their delta bound: the
 * idle early-return path advances it *before* the secondary imports have run,
 * and that is the path ~98% of runs take — so a cross-reference an MD adds
 * during a half hour with no `LIBRARY_RELEASE` edit would be skipped at that
 * run and then excluded forever. Each secondary import therefore keeps its
 * own `cronjob_runs` row and advances it only on its own success.
 *
 * `cronjob_runs.job_name` is `varchar(64)`; all four fit.
 */
const ARTIST_CROSSREF_JOB_NAME = `${JOB_NAME}:artist-crossref`;
const RELEASE_CROSSREF_JOB_NAME = `${JOB_NAME}:release-crossref`;
const COMPILATION_TRACKS_JOB_NAME = `${JOB_NAME}:compilation-tracks`;
/** Not a delta bound — the "last full reconciliation" clock. See `isSecondaryFullPassDue`. */
const SECONDARY_FULL_JOB_NAME = `${JOB_NAME}:secondary-full`;

/**
 * Rows per multi-row compilation-track INSERT. Four columns x 1,000 rows =
 * 4,000 bind parameters, comfortably under Postgres's 65,535 limit.
 */
const CTA_INSERT_CHUNK_ROWS = 1000;

/**
 * Above this many delta release ids, the compilation-track fetch drops its
 * `IN` list and pulls the table in full — the same work, without a
 * 50k-element list in a heredoc.
 */
const CTA_DELTA_ID_MAX = 500;

/** How stale the last full secondary reconciliation may get before one is forced. */
const SECONDARY_FULL_PASS_INTERVAL_HOURS = 24;

/**
 * Split an array into fixed-size chunks. Empty input yields no chunks.
 */
const chunk = <T>(items: T[], size: number): T[][] => {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`[library-etl] chunk() size must be a positive integer, got ${size}.`);
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

/**
 * Whether the secondary imports should drop their delta bounds and run
 * unbounded this pass.
 *
 * This is the whole of the backfill story, and it is not a nicety. The newest
 * upstream `LIBRARY_CODE_CROSS_REFERENCE` edit is 17 months old and the
 * newest `RELEASE_CROSS_REFERENCE` edit is 18 **years** old, so a timestamp
 * bound alone makes both deltas permanently empty on the first run after
 * deploy — and the unbounded re-import has been doubling as the retry that
 * has been slowly narrowing the BS#2386 shortfall (`imported 74, skipped 35`
 * every working run). A missing watermark row is also "due", which is the
 * first-run backfill the old `isFirstCrossrefRun` flag was reaching for.
 *
 * 24 h is not a reduction in that retry cadence: today's retry already sits
 * behind the release-delta gate and therefore runs only on work slots, which
 * were measured at ~1.15x/day. An operator can force a pass immediately by
 * deleting the `library-etl:secondary-full` row.
 */
const isSecondaryFullPassDue = (lastFullPassMs: number | null, nowMs: number): boolean => {
  if (lastFullPassMs == null) return true;
  return nowMs - lastFullPassMs >= SECONDARY_FULL_PASS_INTERVAL_HOURS * 60 * 60 * 1000;
};

// Schema-qualified reference to the `fold_artist_name(text)` SQL function
// (migration 0134 / BS#1095, mirroring the `artistIdFromName` runtime-path
// fix in `apps/backend/services/library.service.ts` for BS#1897). Derived
// from `WXYC_SCHEMA_NAME` the same way the `@wxyc/database` `pgSchema` object
// and the other job SQL builders are, so the per-worker test-isolation
// schema resolves correctly. `""`-escaped for the (theoretical)
// quoted-identifier case.
const FOLD_SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const FOLD_ARTIST_NAME_FN = sql.raw(`"${FOLD_SCHEMA}"."fold_artist_name"`);

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

type EnsuredArtist = { id: number; artist_name: string };

const ensureArtist = async (
  dbClient: DbClient,
  artistName: string,
  alphabeticalName: string,
  isVarious: boolean,
  genreId: number,
  codeLetters: string | null,
  artistGenreCode: number,
  artistCache: Map<string, EnsuredArtist>,
  addDate?: string,
  lastModified?: Date
): Promise<EnsuredArtist> => {
  const normalizedLetters = codeLetters ?? '??';
  const artistKey = isVarious
    ? `${artistName.toLowerCase()}|${normalizedLetters}`
    : `${artistName.toLowerCase()}|${normalizedLetters}|${genreId}|${artistGenreCode}`;
  const cached = artistCache.get(artistKey);
  if (cached) return cached;

  const lettersLower = normalizedLetters.toLowerCase().trim();
  const query = isVarious
    ? dbClient
        .select({ id: artists.id, artist_name: artists.artist_name })
        .from(artists)
        .where(
          and(
            // Unicode-form + diacritic + case insensitive match (BS#1095,
            // mirroring the BS#1897 runtime-path fix). The former
            // `lower(artist_name) = lower($name)` is collation-aware but NOT
            // Unicode-form aware: `Nilüfer Yanya` in NFC (`ü` = U+00FC) vs
            // NFD (`u` + U+0308) is byte-distinct and misses, so this ETL
            // inserted a duplicate `artists` row per composition form.
            // `fold_artist_name` (migration 0134) folds NFC/NFD/ASCII-fold/
            // case onto one key on BOTH sides — an app-side `.toLowerCase()`
            // on the input alone can't match an NFD-stored row.
            sql`${FOLD_ARTIST_NAME_FN}(${artists.artist_name}) = ${FOLD_ARTIST_NAME_FN}(${artistName})`,
            sql`lower(${artists.code_letters}) = ${lettersLower}`
          )
        )
        .limit(1)
    : dbClient
        .select({ id: artists.id, artist_name: artists.artist_name })
        .from(artists)
        .innerJoin(genre_artist_crossreference, eq(genre_artist_crossreference.artist_id, artists.id))
        .where(
          and(
            sql`${FOLD_ARTIST_NAME_FN}(${artists.artist_name}) = ${FOLD_ARTIST_NAME_FN}(${artistName})`,
            sql`lower(${artists.code_letters}) = ${lettersLower}`,
            eq(genre_artist_crossreference.genre_id, genreId),
            eq(genre_artist_crossreference.artist_genre_code, artistGenreCode)
          )
        )
        .limit(1);

  const existing = await query;
  if (existing.length) {
    const ensured = { id: existing[0].id, artist_name: existing[0].artist_name };
    artistCache.set(artistKey, ensured);
    return ensured;
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
  const ensured = { id, artist_name: artistName };
  artistCache.set(artistKey, ensured);
  return ensured;
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
      set: { artist_genre_code: sql`excluded.artist_genre_code` },
      // BS#1059 mechanic.
      setWhere: sql`${genre_artist_crossreference.artist_genre_code} IS DISTINCT FROM excluded.artist_genre_code`,
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
        // Unicode-form + diacritic + case insensitive match (BS#1095,
        // mirroring the BS#1897 runtime-path fix + this file's `ensureArtist`
        // above). See the comment there for the byte-distinct NFC/NFD
        // collision this replaces.
        sql`${FOLD_ARTIST_NAME_FN}(${artists.artist_name}) = ${FOLD_ARTIST_NAME_FN}(${artistName})`,
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
 * Delta bound shared by both cross-reference tables (BS#2424).
 *
 * tubafrenzy stamps `TIME_LAST_MODIFIED` on create AND on edit in both
 * repositories, so `> watermark` is a real delta and mirrors what
 * `buildReleaseQuery` already does for `LIBRARY_RELEASE`.
 *
 * `IS NULL` is deliberately in-delta. Prod carries zero NULL-stamped rows in
 * either table, but a row that were ever inserted without a stamp would
 * otherwise be invisible to the bound forever, and re-importing an unstamped
 * row is a no-op upsert. `dev_env/etl-seed.sql` relies on this too.
 */
const buildCrossRefTimeBound = (watermarkMs: number | null) =>
  watermarkMs == null ? '' : `WHERE (cr.TIME_LAST_MODIFIED IS NULL OR cr.TIME_LAST_MODIFIED > ${watermarkMs})`;

/**
 * Artist-to-artist cross-references (aliases, side projects, related artists)
 * from tubafrenzy's LIBRARY_CODE_CROSS_REFERENCE table.
 *
 * A null watermark emits no bound, which is both the first-run backfill and
 * the periodic full reconciliation pass (`isSecondaryFullPassDue`).
 */
const buildArtistCrossRefQuery = (watermarkMs: number | null): string => `
    SELECT
      REPLACE(REPLACE(src.PRESENTATION_NAME, '\\t', ' '), '\\n', ' '),
      src.CALL_LETTERS,
      REPLACE(REPLACE(tgt.PRESENTATION_NAME, '\\t', ' '), '\\n', ' '),
      tgt.CALL_LETTERS,
      REPLACE(REPLACE(IFNULL(cr.COMMENT, ''), '\\t', ' '), '\\n', ' ')
    FROM LIBRARY_CODE_CROSS_REFERENCE cr
    JOIN LIBRARY_CODE src ON cr.CROSS_REFERENCING_ARTIST_ID = src.ID
    JOIN LIBRARY_CODE tgt ON cr.CROSS_REFERENCED_LIBRARY_CODE_ID = tgt.ID
    ${buildCrossRefTimeBound(watermarkMs)};
  `;

/**
 * Fetch artist-to-artist cross-references, bounded on the
 * `library-etl:artist-crossref` watermark (BS#2424).
 */
const fetchLegacyArtistCrossRefs = async (watermarkMs: number | null): Promise<LegacyCrossrefRow[]> => {
  const raw = await legacyDB.send(buildArtistCrossRefQuery(watermarkMs));
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
 * Release cross-references (guest appearances, collaborations) from
 * tubafrenzy's RELEASE_CROSS_REFERENCE table. See `buildArtistCrossRefQuery`
 * for the bound's semantics.
 */
const buildReleaseCrossRefQuery = (watermarkMs: number | null): string => `
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
    JOIN GENRE g ON lc.GENRE_ID = g.ID
    ${buildCrossRefTimeBound(watermarkMs)};
  `;

/**
 * Fetch release cross-references, bounded on the
 * `library-etl:release-crossref` watermark (BS#2424).
 */
const fetchLegacyReleaseCrossRefs = async (watermarkMs: number | null): Promise<LegacyReleaseCrossrefRow[]> => {
  const raw = await legacyDB.send(buildReleaseCrossRefQuery(watermarkMs));
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
 * Uses `ON CONFLICT ... DO UPDATE` for idempotent upserts.
 *
 * **This loop shares BS#2424's pathology and is deliberately left alone.**
 * `artist_crossreference` carries `touch_library_watermark_from_artist_crossreference`
 * (migration 0138) — the same unqualified `FOR EACH STATEMENT` trigger against the
 * same single-row `library_watermark` table that made `importCompilationTracks` a
 * lock-starvation source, so this row-at-a-time loop is the same bug class at a
 * smaller row count (0138's own comment calls this table "librarian-edited at human
 * cadence"). It is NOT batchable by copying `importCompilationTracks`: `DO UPDATE`
 * raises `cannot affect row a second time` when one statement's VALUES list carries
 * an intra-statement duplicate, where `DO NOTHING` skips it — so batching here needs
 * an in-memory dedupe on the conflict target first. Revisit if this table ever grows.
 *
 * The third importer, `importReleaseCrossRefs`, does NOT share this: its
 * `artist_library_crossreference` carries only the `FOR EACH ROW` `cdc_notify`
 * trigger (migration 0046), never the statement-level watermark one.
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
        // BS#1059 mechanic; nullable column needs IS DISTINCT FROM.
        setWhere: sql`${artist_crossreference.comment} IS DISTINCT FROM excluded.comment`,
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
 * One `compilation_track_artist` row as handed to the batched INSERT. Named
 * because both the accumulator and the failure-path formatter refer to it —
 * the four columns here are also what fixes the bind-parameter budget that
 * `CTA_INSERT_CHUNK_ROWS` is sized against.
 */
type CompilationTrackInsertRow = {
  library_id: number;
  artist_name: string;
  track_title: string | null;
  track_position: string | null;
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

/**
 * `COMPILATION_TRACK_ARTIST` query, optionally bounded on a set of
 * `LIBRARY_RELEASE_ID`s (BS#2424).
 *
 * The table is four columns with **no timestamp and no surrogate key**
 * (`V008__add-compilation-track-artist.sql`), so it cannot be bounded on a
 * modification time the way the two cross-reference tables are. The bound is
 * instead the set of release ids whose `LIBRARY_RELEASE` row changed since
 * this import's own watermark.
 *
 * `null` means a full pass — the first run, or the periodic reconciliation.
 */
const buildCompilationTrackQuery = (libraryReleaseIds: number[] | null): string => {
  if (libraryReleaseIds != null && libraryReleaseIds.length === 0) {
    // `IN ()` is a MySQL syntax error, and `fetchLegacyCompilationTracks`
    // swallows query failures — the caller must return early instead, or the
    // failure surfaces as a misleading "table not available" warning.
    throw new RangeError('[library-etl] buildCompilationTrackQuery called with an empty release-id set.');
  }
  const bound = libraryReleaseIds == null ? '' : `WHERE LIBRARY_RELEASE_ID IN (${libraryReleaseIds.join(', ')})`;
  return `
      SELECT
        LIBRARY_RELEASE_ID,
        REPLACE(REPLACE(ARTIST_NAME, '\\t', ' '), '\\n', ' '),
        REPLACE(REPLACE(IFNULL(TRACK_TITLE, ''), '\\t', ' '), '\\n', ' '),
        REPLACE(REPLACE(IFNULL(TRACK_POSITION, ''), '\\t', ' '), '\\n', ' ')
      FROM COMPILATION_TRACK_ARTIST
      ${bound};
  `;
};

/**
 * The `LIBRARY_RELEASE` ids whose row changed since the compilation-track
 * watermark. Plain `>` rather than the cross-references' `IS NULL OR >`,
 * mirroring `buildReleaseQuery`: an unstamped `LIBRARY_RELEASE` row is
 * invisible to the release import too, and admitting it here would put its
 * ids in the delta on every single run forever. The periodic full pass is
 * what covers that case.
 *
 * **This is a proxy, not a bound on the table's own changes, and the proxy is
 * blind to the only thing that writes it.** tubafrenzy never writes
 * `COMPILATION_TRACK_ARTIST` (it is read-only there —
 * `libs/lucene/.../BuildIndexCLI.java` and `LibraryRelease.java`); the rows
 * come from library-metadata-lookup's `scripts/va_disambiguate` SQL writer,
 * which emits bare `INSERT INTO COMPILATION_TRACK_ARTIST` statements and
 * never touches `LIBRARY_RELEASE`. So a freshly disambiguated batch does not
 * move any release's `TIME_LAST_MODIFIED` and is invisible to this delta. New
 * compilation-track credits therefore arrive on the 24-hour full
 * reconciliation pass rather than within 30 minutes — a real latency change
 * from before BS#2424, bounded at a day, and the reason the full pass is not
 * optional for this import either.
 */
const fetchCompilationTrackDeltaReleaseIds = async (watermarkMs: number): Promise<number[]> => {
  const raw = await legacyDB.send(`SELECT ID FROM LIBRARY_RELEASE WHERE TIME_LAST_MODIFIED > ${watermarkMs};`);
  if (raw.trim().length === 0) return [];
  const ids: number[] = [];
  for (const line of raw.trim().split('\n')) {
    // Strict digits, not `Number.isInteger(Number(line))`: `Number('')` is 0
    // and `Number.isInteger(0)` is true, so an interior blank line would put
    // release id 0 in the `IN` list and take the bounded path on a set that
    // should have been empty.
    const trimmed = line.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    ids.push(Number(trimmed));
  }
  return ids;
};

type CompilationTrackFetch = {
  rows: LegacyCompilationTrackRow[];
  /** The bound actually used, or `null` for a full pass. Reused as the `library` map filter. */
  legacyReleaseIds: number[] | null;
  /** True when the upstream read failed; the caller must not advance the watermark. */
  failed: boolean;
};

const fetchLegacyCompilationTracks = async (watermarkMs: number | null): Promise<CompilationTrackFetch> => {
  let deltaIds: number[] | null = null;
  if (watermarkMs != null) {
    deltaIds = await fetchCompilationTrackDeltaReleaseIds(watermarkMs);
    if (deltaIds.length === 0) {
      return { rows: [], legacyReleaseIds: [], failed: false };
    }
    if (deltaIds.length > CTA_DELTA_ID_MAX) {
      // A full re-sync, or an unusually large librarian batch. Same work
      // either way, without a 50k-element list in a heredoc.
      console.log(
        `[library-etl] Compilation-track delta covers ${deltaIds.length} releases (> ${CTA_DELTA_ID_MAX}); falling back to a full fetch.`
      );
      deltaIds = null;
    }
  }

  // Built OUTSIDE the try. The builder's empty-set `RangeError` exists
  // precisely so a caller that forgets the early return above fails loudly;
  // inside the try, the catch below would swallow it into the misleading
  // "table not available" warning it was written to avoid — and then pin the
  // watermark via `failed: true`.
  const query = buildCompilationTrackQuery(deltaIds);

  try {
    const raw = await legacyDB.send(query);
    return { rows: parseLegacyCompilationTrackRows(raw), legacyReleaseIds: deltaIds, failed: false };
  } catch (error) {
    // Kept tolerant (the table may legitimately be absent in some
    // environments), but `failed` keeps the watermark where it is so the next
    // run re-attempts exactly this delta instead of skipping past it.
    console.warn('[library-etl] COMPILATION_TRACK_ARTIST not available, skipping:', error);
    return { rows: [], legacyReleaseIds: deltaIds, failed: true };
  }
};

/**
 * Import compilation-track credits in **batched multi-row statements**
 * (BS#2424).
 *
 * This used to issue one awaited `INSERT ... ON CONFLICT DO NOTHING` per row
 * over ~140,617 upstream rows, inside the release import's write transaction
 * — 140,617 sequential round trips, measured at 12-15 minutes per working
 * run, and 140,617 firings of the `FOR EACH STATEMENT`
 * `touch_library_watermark_from_compilation_track_artist` trigger against the
 * single-row `library_watermark` table whose row lock it holds for the whole
 * transaction (which is what starved `legacy-linkage-resolve` in BS#2413).
 *
 * Two properties are load-bearing and pinned by tests:
 *
 * - **`ON CONFLICT DO NOTHING` stays UNTARGETED.** The table carries two
 *   unique indexes (`cta_unique_idx` and the partial
 *   `cta_unique_null_track_idx`); an untargeted clause arbitrates on both,
 *   and naming a target would silently stop deduping the other. Those two
 *   indexes are documented canonically on `compilation_track_artist` in
 *   `shared/database/src/schema.ts` — including the standing question of
 *   whether the partial one is ever dropped. Check there before changing
 *   this clause; this comment is a dependent, not the source of truth.
 * - **Duplicates *within one statement* are skipped, not inserted twice.**
 *   `DO NOTHING` uses speculative insertion and sees rows inserted earlier in
 *   the same command (verified on PG 14.24 — prod's major — and 18.0). This
 *   is not hypothetical: upstream holds 2,070 surplus rows that collide
 *   intra-table on exactly `cta_unique_idx`'s tuple.
 *
 * `legacyReleaseIds` filters the `legacy_release_id -> library.id` map load;
 * `null` (a full pass) scans the whole `library` table as before.
 *
 * **Counter semantics are unchanged on purpose.** `imported` still counts
 * rows that resolved to a `library` row and were handed to the insert, NOT
 * rows actually written — the 6-for-6 BS#2413 correlation was read against
 * these log lines, and switching to a real affected-row count would collapse
 * the number for reasons unrelated to coverage.
 */
const importCompilationTracks = async (
  tx: DbTransaction,
  rows: LegacyCompilationTrackRow[],
  legacyReleaseIds: number[] | null
): Promise<{ imported: number; skipped: number; batches: number }> => {
  // Build map of legacy_release_id -> library.id. Bounded to the delta's
  // releases when there is one; `inArray` rather than an interpolated array
  // in a `sql` template (docs/bulk-update-playbook.md:69 — that defect has
  // shipped three times).
  const releaseRows = await tx
    .select({ id: library.id, legacyReleaseId: library.legacy_release_id })
    .from(library)
    .where(
      legacyReleaseIds == null
        ? sql`${library.legacy_release_id} IS NOT NULL`
        : and(sql`${library.legacy_release_id} IS NOT NULL`, inArray(library.legacy_release_id, legacyReleaseIds))
    );
  const releaseMap = new Map<number, number>();
  for (const row of releaseRows) {
    if (row.legacyReleaseId != null) {
      releaseMap.set(row.legacyReleaseId, row.id);
    }
  }

  let skipped = 0;
  const values: CompilationTrackInsertRow[] = [];
  for (const row of rows) {
    const libraryId = releaseMap.get(row.libraryReleaseId);
    if (!libraryId) {
      skipped++;
      continue;
    }
    values.push({
      library_id: libraryId,
      artist_name: row.artistName,
      track_title: row.trackTitle,
      track_position: row.trackPosition,
    });
  }

  const batches = chunk(values, CTA_INSERT_CHUNK_ROWS);
  for (const [index, batch] of batches.entries()) {
    try {
      await tx.insert(compilation_track_artist).values(batch).onConflictDoNothing();
    } catch (error) {
      // A malformed row now aborts a 1,000-row statement rather than a
      // 1-row one; either way it aborts the transaction, so the only thing
      // lost is which row it was. Log the window so it stays identifiable.
      //
      // The offsets index `values` — the rows that RESOLVED to a library row
      // — not the upstream `COMPILATION_TRACK_ARTIST` rows, and every row
      // dropped by the `!libraryId` skip above shifts them. So name the
      // window's endpoints by their key tuple as well: with a non-zero
      // `skipped` count the offsets alone cannot be mapped back to the
      // source table, and this branch only runs when the whole transaction
      // has already aborted.
      const first = index * CTA_INSERT_CHUNK_ROWS;
      const head = batch[0];
      const tail = batch[batch.length - 1];
      const describe = (row: CompilationTrackInsertRow) =>
        `library_id=${row.library_id} artist=${JSON.stringify(row.artist_name)} track=${JSON.stringify(row.track_title)}`;
      console.error(
        `[library-etl] Compilation track insert failed on batch ${index + 1}/${batches.length} ` +
          `(resolved rows ${first}-${first + batch.length - 1} of ${values.length}; ` +
          `first: ${describe(head)}; last: ${describe(tail)}).`
      );
      throw error;
    }
  }

  return { imported: values.length, skipped, batches: batches.length };
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
        // BS#1059 mechanic; nullable column needs IS DISTINCT FROM.
        setWhere: sql`${artist_library_crossreference.comment} IS DISTINCT FROM excluded.comment`,
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

/**
 * Columns the library-etl is the source of truth for — i.e. the columns it
 * writes during INSERT and refreshes from `excluded.*` on a legacy_release_id
 * conflict. Pinned by a unit test so PG-only / LML-resolved columns (`id`,
 * `plays`, `label`, `label_id`, `artwork_url`, `canonical_entity_*`,
 * `search_doc`) can't drift into the SET list and clobber human-curated or
 * downstream-resolved fields. `legacy_release_id` is the conflict key itself
 * and is intentionally excluded from the SET list.
 */
export const LEGACY_SOURCED_LIBRARY_COLUMNS = [
  'artist_id',
  'artist_name',
  'genre_id',
  'format_id',
  'alternate_artist_name',
  'album_artist',
  'album_title',
  'code_number',
  'code_volume_letters',
  'disc_quantity',
  'add_date',
  'last_modified',
  'date_lost',
  'date_found',
  'on_streaming',
] as const;

type LegacySourcedColumn = (typeof LEGACY_SOURCED_LIBRARY_COLUMNS)[number];

const buildLegacySourcedSetMap = (): Record<LegacySourcedColumn, ReturnType<typeof sql>> => {
  const map = {} as Record<LegacySourcedColumn, ReturnType<typeof sql>>;
  for (const column of LEGACY_SOURCED_LIBRARY_COLUMNS) {
    map[column] = sql.raw(`excluded."${column}"`);
  }
  return map;
};

/** Conflict-WHERE paired with buildLegacySourcedSetMap (BS#1063). Pinned by unit test. */
const buildLegacySourcedSetWhere = () =>
  sql.join(
    LEGACY_SOURCED_LIBRARY_COLUMNS.map((col) => sql.raw(`"library"."${col}" IS DISTINCT FROM excluded."${col}"`)),
    sql.raw(' OR ')
  );

// Cached once at module load; the helpers above are pure functions of the
// column list, so per-row recomputation in the upsert loop is pure waste.
const LEGACY_SOURCED_SET_MAP = buildLegacySourcedSetMap();
const LEGACY_SOURCED_SET_WHERE = buildLegacySourcedSetWhere();

/**
 * Loads every `legacy_release_id` a librarian has hard-deleted through
 * `DELETE /library/:id` (BS#2112). This job is the denylist's ONLY consumer.
 *
 * Why it exists: a Backend-side delete does not reach tubafrenzy, so the
 * upstream `LIBRARY_RELEASE` row survives. This job still runs every 30
 * minutes (`cron-schedule` in `package.json`; it was NOT flipped to
 * `job-type: one-shot` alongside `flowsheet-etl`/`rotation-etl` at the
 * wiki#88 Phase 3 decommission), so the delta pass re-selects that row, finds
 * no `library` row carrying its `legacy_release_id`, and takes the INSERT
 * branch of `ON CONFLICT (legacy_release_id) DO UPDATE` — resurrecting the
 * release under a NEW `library.id` with its `rotation`, `album_metadata`,
 * `reviews`, and `album_critic_reviews` rows gone for good (they cascaded
 * against the OLD id, and this job does not import them).
 *
 * **Deliberately unfiltered.** There is no `last_run` / delta predicate here
 * and there must never be one: the ETL's own delta filter is dropped
 * entirely by the documented full-resync recipe (`DELETE FROM cronjob_runs
 * WHERE job_name LIKE 'library-etl%'`), which re-selects the whole upstream
 * catalog in one pass. A denylist that were itself windowed would let that
 * single run resurrect every release ever deleted. The table holds one small
 * row per deletion, so loading all of it per run is cheap.
 */
export const loadDeleteDenylist = async (tx: DbTransaction): Promise<Set<number>> => {
  const rows = await tx
    .select({ legacy_release_id: library_delete_denylist.legacy_release_id })
    .from(library_delete_denylist);
  return new Set(rows.map((row) => row.legacy_release_id));
};

/**
 * Fresh, single-release denylist read taken at the point of write.
 *
 * `loadDeleteDenylist` above snapshots the whole table ONCE, at the top of a
 * transaction that then runs for the length of the import — minutes on a delta
 * pass, much longer on a full re-sync. `db.transaction()` is READ COMMITTED, so
 * that Set is fixed at its statement's snapshot while every LATER statement in
 * the same transaction takes a fresh one. A delete committing after the load
 * but before the loop reaches its release is therefore invisible to the Set;
 * `findExistingRelease` then takes its own fresh snapshot, sees the deleted
 * row gone, and hands the release to the INSERT branch — resurrecting it under
 * a new `library.id` stripped of its cascaded dependents.
 *
 * That state is terminal and self-concealing without this check: every
 * subsequent run consults the denylist, finds the id, and `continue`s, so the
 * resurrected row is never updated and never removed, and the log line says
 * "skipped as deleted" while the release sits in the catalog.
 *
 * This narrows the exposure from the whole run to a single statement. It does
 * not close it outright — a delete can still commit between this read and the
 * upsert — which is what `reconcileDenylistedInserts` (below) is for. The
 * in-memory pre-filter is kept ahead of this call: it costs nothing and keeps
 * the common case (a denylisted release re-selected on every full re-sync) from
 * paying a round trip.
 */
export const isDeniedAtWriteTime = async (tx: DbTransaction, legacyReleaseId: number): Promise<boolean> => {
  const rows = await tx
    .select({ legacy_release_id: library_delete_denylist.legacy_release_id })
    .from(library_delete_denylist)
    .where(eq(library_delete_denylist.legacy_release_id, legacyReleaseId))
    .limit(1);
  return rows.length > 0;
};

/**
 * Last line of defence against a resurrection, run once at the end of the
 * import transaction: join `library` to `library_delete_denylist` and see
 * whether any denylisted release is present in the catalog after all.
 *
 * Two populations, treated differently on purpose.
 *
 *   - **Inserted by THIS run** (`insertedLegacyIds`). The delete committed in
 *     the gap between `isDeniedAtWriteTime` and the upsert. These rows are
 *     deleted here. That is safe in a way a general cleanup would not be:
 *     they were created by this same uncommitted transaction, so nothing
 *     outside it has ever seen them, no dependent row can have accrued
 *     against them, and removing them restores exactly the state the
 *     librarian asked for. Because this runs in the same transaction as the
 *     insert, the whole thing is atomic — an aborted run leaves no
 *     resurrection either.
 *
 *   - **Present but NOT inserted by this run.** A resurrection that slipped
 *     through before this check existed, or a row an operator restored by
 *     hand without clearing the denylist. It is NOT deleted: dependents may
 *     have accrued against it (enrichment writes `album_metadata`, an MD may
 *     have binned it), and an ETL silently deleting catalog rows that predate
 *     its own run is a worse failure mode than the one it is fixing. It is
 *     reported loudly instead, and the caller exits non-zero — the point is
 *     that the state stops being invisible.
 *
 * Driven from the denylist side, which is small (one row per hard delete
 * ever), so this is a bounded lookup regardless of catalog size.
 */
export const reconcileDenylistedInserts = async (
  tx: DbTransaction,
  insertedLegacyIds: Set<number>
): Promise<{ removed: number[]; stranded: Array<{ id: number; legacy_release_id: number }> }> => {
  const present = await tx
    .select({ id: library.id, legacy_release_id: library.legacy_release_id })
    .from(library_delete_denylist)
    .innerJoin(library, eq(library.legacy_release_id, library_delete_denylist.legacy_release_id));

  const removedIds: number[] = [];
  const stranded: Array<{ id: number; legacy_release_id: number }> = [];
  for (const row of present) {
    if (insertedLegacyIds.has(row.legacy_release_id)) {
      removedIds.push(row.id);
    } else {
      stranded.push(row);
    }
  }

  if (removedIds.length > 0) {
    await tx.delete(library).where(inArray(library.id, removedIds));
  }

  return { removed: removedIds, stranded };
};

/**
 * Reports denylisted releases found present in the catalog that this run did
 * not create.
 *
 * Reported, never auto-repaired: these rows predate the current run, so
 * dependents may have accrued against them (enrichment writes
 * `album_metadata`, an MD may have binned it), and an ETL silently deleting
 * catalog rows it did not create is a worse failure mode than the one being
 * reported. Non-zero exit code so a denylisted release sitting in the catalog
 * is a loud run outcome rather than a silent one — the whole failure this
 * guards against was that it concealed itself, with every later run happily
 * logging "skipped as deleted" for a release that was right there.
 */
export const reportStrandedResurrections = (stranded: Array<{ id: number; legacy_release_id: number }>): void => {
  if (stranded.length === 0) {
    return;
  }
  console.error(
    `[library-etl] ${stranded.length} denylisted release(s) are PRESENT in the library and were not inserted by this run — a resurrection predating this pass, or a row restored by hand whose denylist entry was never cleared. Not auto-removed. Resolve by hand: either DELETE the library row through DELETE /library/:id, or clear the denylist row if the release is meant to be back. ` +
      stranded.map((row) => `library.id=${row.id} legacy_release_id=${row.legacy_release_id}`).join('; ')
  );
  process.exitCode = 1;
};

/**
 * Phase 2 — the secondary imports (BS#2424).
 *
 * Three things changed here, and all three matter:
 *
 * 1. **It runs on EVERY pass**, including the ~98% that return "No new legacy
 *    releases found". With the secondary imports behind the release-delta
 *    early return *and* bounded on a watermark, a cross-reference-only edit
 *    would be skipped at that run and then excluded forever. See the
 *    per-import watermark constants at the top of this file.
 * 2. **Every legacy read happens with no Postgres transaction open.** Each is
 *    an SSH `execCommand` spawning a remote `mysql` process; the
 *    compilation-track read alone streams up to 140,617 rows, and none of
 *    them needs a write transaction held open while it runs.
 * 3. It runs strictly AFTER phase 1 commits. `importCompilationTracks` and
 *    `importReleaseCrossRefs` (via `findAlbumId`) resolve against `library`
 *    rows phase 1 writes, and `reconcileDenylistedInserts`' `tx.delete` must
 *    land before a compilation track can reference the row — read-your-writes
 *    becomes read-your-committed-writes, which is strictly safer. It re-reads
 *    `genreMap` itself rather than inheriting phase 1's in-transaction
 *    snapshot.
 *
 * One consequence worth stating: a cross-reference failure no longer rolls
 * back the release import. The releases stay committed and only the secondary
 * watermarks fail to advance, so the next run retries exactly the failed part
 * — which is why every secondary import, compilation tracks included, has a
 * watermark of its own.
 */
const runSecondaryImports = async (runStartedAt: Date) => {
  const lastFullPassMs = await getLastRunTimestamp(SECONDARY_FULL_JOB_NAME);
  const fullPass = isSecondaryFullPassDue(lastFullPassMs, runStartedAt.getTime());
  if (fullPass) {
    console.log(
      `[library-etl] Secondary imports: running a FULL reconciliation pass (last full pass: ${lastFullPassMs == null ? 'never' : new Date(lastFullPassMs).toISOString()}).`
    );
  }

  // A null watermark means an unbounded fetch for that import — which is both
  // the first-run backfill and the periodic full pass.
  const artistCrossRefWatermark = fullPass ? null : await getLastRunTimestamp(ARTIST_CROSSREF_JOB_NAME);
  const releaseCrossRefWatermark = fullPass ? null : await getLastRunTimestamp(RELEASE_CROSSREF_JOB_NAME);
  const compilationTrackWatermark = fullPass ? null : await getLastRunTimestamp(COMPILATION_TRACKS_JOB_NAME);

  // --- Legacy reads, with NO Postgres transaction open ---
  const legacyArtistCrossRefs = await fetchLegacyArtistCrossRefs(artistCrossRefWatermark);
  const legacyReleaseCrossRefs = await fetchLegacyReleaseCrossRefs(releaseCrossRefWatermark);
  const legacyCTA = await fetchLegacyCompilationTracks(compilationTrackWatermark);

  await db.transaction(async (tx) => {
    const genreRows = await tx.select().from(genres);
    const genreMap = new Map(genreRows.map((genre) => [genre.genre_name.toLowerCase(), genre.id]));

    // Shared caches for cross-reference resolution
    const artistIdCache = new Map<string, number>();
    const albumIdCache = new Map<string, number>();

    const artistCrossResult = await importArtistCrossRefs(tx, legacyArtistCrossRefs, artistIdCache);
    if (artistCrossResult.imported > 0 || artistCrossResult.skipped > 0) {
      console.log(
        `[library-etl] Artist cross-references: imported ${artistCrossResult.imported}, skipped ${artistCrossResult.skipped}.`
      );
    }

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

    if (legacyCTA.rows.length > 0) {
      const ctaResult = await importCompilationTracks(tx, legacyCTA.rows, legacyCTA.legacyReleaseIds);
      console.log(
        `[library-etl] Compilation track artists: imported ${ctaResult.imported}, skipped ${ctaResult.skipped}. (${ctaResult.batches} batched statement(s) of up to ${CTA_INSERT_CHUNK_ROWS} rows.)`
      );
    }

    await updateLastRun(tx, ARTIST_CROSSREF_JOB_NAME, runStartedAt);
    await updateLastRun(tx, RELEASE_CROSSREF_JOB_NAME, runStartedAt);
    // A failed upstream read must not advance past the delta it never saw.
    if (!legacyCTA.failed) {
      await updateLastRun(tx, COMPILATION_TRACKS_JOB_NAME, runStartedAt);
      if (fullPass) {
        await updateLastRun(tx, SECONDARY_FULL_JOB_NAME, runStartedAt);
      }
    }
  });
};

const run = async () => {
  try {
    const runStartedAt = new Date();
    const lastRunMs = await getLastRunTimestamp(JOB_NAME);
    const legacyReleases = await fetchLegacyReleases(lastRunMs);

    if (legacyReleases.length === 0) {
      console.log('[library-etl] No new legacy releases found.');
      // Still sweep for denylisted releases sitting in the catalog (BS#2112).
      // An idle delta pass is the COMMON case, so skipping the check here
      // would leave detection dependent on the next run that happens to have
      // work — and the state being detected is one that hides itself. The
      // empty inserted-set makes this strictly read-only; nothing is deleted.
      const idleReconcile = await db.transaction((tx) => reconcileDenylistedInserts(tx, new Set<number>()));
      reportStrandedResurrections(idleReconcile.stranded);
      await updateLastRun(db, JOB_NAME, runStartedAt);
      // BS#2424: NO early return here. The secondary imports are bounded on
      // their own watermarks now, so they must still run on an idle pass —
      // otherwise a cross-reference-only edit is skipped at this run and then
      // excluded forever by a watermark that has already moved past it.
    } else {
      let insertedCount = 0;
      let updatedFromLegacyConflictCount = 0;
      let skippedCount = 0;
      let denylistedCount = 0;
      let denylistedAtWriteTimeCount = 0;
      let resurrectionsUndone = 0;
      let strandedResurrections: Array<{ id: number; legacy_release_id: number }> = [];

      // BS#2424: the two legacy reads are hoisted ABOVE the transaction.
      // Each is an SSH `execCommand` spawning a remote `mysql` process;
      // neither needs a Postgres write transaction open while it runs.
      const legacyGenreNames = await fetchLegacyGenres();
      const canonicalFormatNames = await fetchLegacyFormats();

      await db.transaction(async (tx) => {
        // Sync genres and formats from legacy database before processing releases
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

        const artistCache = new Map<string, EnsuredArtist>();

        // BS#2112. Loaded once per run, ahead of the loop, and consulted first
        // for every release — before `findExistingRelease`, so a deleted
        // release can neither be re-inserted nor have its `legacy_release_id`
        // back-stamped onto some other row by the canonical-tuple backfill.
        //
        // This is a PRE-FILTER, not the only check. It is a snapshot taken once
        // at the top of a transaction that runs for the length of the import, so
        // a delete committing mid-run is invisible to it; `isDeniedAtWriteTime`
        // re-reads per release at the point of write and
        // `reconcileDenylistedInserts` sweeps up after the loop. See those two
        // for the mechanism.
        const deleteDenylist = await loadDeleteDenylist(tx);
        /** Legacy ids this run took the INSERT branch for — the reconcile pass's safe-to-undo set. */
        const insertedLegacyIds = new Set<number>();

        for (const release of legacyReleases) {
          if (deleteDenylist.has(release.release_id)) {
            denylistedCount += 1;
            continue;
          }

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
            console.warn(
              `[library-etl] Missing format "${formatParsed.formatName}" for release ${release.release_id}.`
            );
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
          const artistGenreCode = artistInfo.isVarious
            ? VARIOUS_ARTISTS_CODE_NUMBER
            : (release.artist_call_numbers ?? 0);

          const { id: artistId, artist_name: canonicalArtistName } = await ensureArtist(
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

          // BS#2112. Re-read the denylist at the point of write, on a fresh
          // statement snapshot. The Set above was taken once for the whole run
          // and cannot see a delete that committed since; this can, and it runs
          // ahead of `findExistingRelease` because that call's canonical-tuple
          // match can back-stamp a deleted release's `legacy_release_id` onto a
          // different `library` row — a resurrection by a second door, which
          // checking only at the INSERT would miss. See `isDeniedAtWriteTime`.
          if (await isDeniedAtWriteTime(tx, release.release_id)) {
            denylistedAtWriteTimeCount += 1;
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

          // Pre-flight by legacy_release_id so we can split the inserted vs
          // conflict-updated counters in the final log line. The row landed in
          // findExistingRelease's null branch, so the only way the upsert below
          // hits the UPDATE path is via the unique index on legacy_release_id —
          // i.e. an upstream edit since the last sync changed the canonical
          // tuple while preserving the legacy id. Knowing which case fired is
          // operationally useful (a sustained non-zero conflict count signals
          // upstream churn worth investigating).
          const conflictRows = await tx
            .select({ id: library.id })
            .from(library)
            .where(eq(library.legacy_release_id, release.release_id))
            .limit(1);
          const willConflictOnLegacyId = conflictRows.length > 0;

          // Denormalize the canonical `artists.artist_name` onto `library.artist_name`
          // so the column the tsvector / trigram catalog search reads against
          // (`library.artist_name`) is populated at insert time. Omitting it lets
          // the row land NULL — invisible to search, and (pre-fix) tripping the
          // 503-on-any-NULL precondition in library-artist-name-assertion.service.
          //
          // ON CONFLICT (legacy_release_id) DO UPDATE handles the case the
          // pre-flight above identified: the canonical-tuple lookup missed but
          // a row already exists with this legacy_release_id. Without it, the
          // INSERT violates `library_legacy_release_id_idx` and aborts the
          // whole run on first conflict (#752). The SET list is built from
          // LEGACY_SOURCED_LIBRARY_COLUMNS, which is also exported and pinned
          // by a unit test — so PG-only / LML-resolved columns (id, plays,
          // label, label_id, artwork_url, canonical_entity_*, search_doc)
          // can't drift into the SET list by accident.
          await tx
            .insert(library)
            .values({
              artist_id: artistId,
              artist_name: canonicalArtistName,
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
            })
            .onConflictDoUpdate({
              target: library.legacy_release_id,
              set: LEGACY_SOURCED_SET_MAP,
              setWhere: LEGACY_SOURCED_SET_WHERE,
            });

          if (willConflictOnLegacyId) {
            updatedFromLegacyConflictCount += 1;
          } else {
            insertedCount += 1;
            insertedLegacyIds.add(release.release_id);
          }
        }

        // BS#2112. Sweep for anything the two checks above still let through —
        // a delete that committed inside the one-statement gap between
        // `isDeniedAtWriteTime` and the upsert. Runs here, right after the loop
        // that could have created a resurrection and before the cross-reference
        // imports, so an undone row is gone before anything can reference it.
        const reconciled = await reconcileDenylistedInserts(tx, insertedLegacyIds);
        resurrectionsUndone = reconciled.removed.length;
        strandedResurrections = reconciled.stranded;
        if (resurrectionsUndone > 0) {
          insertedCount -= resurrectionsUndone;
          console.warn(
            `[library-etl] Undid ${resurrectionsUndone} resurrection(s) of denylisted release(s) inserted by this run: library ids ${reconciled.removed.join(', ')}.`
          );
        }

        // BS#2424: the cross-reference, compilation-track and secondary
        // watermark writes used to live here, inside this transaction. They
        // are phase 2 now (`runSecondaryImports`), which runs after this
        // transaction COMMITS and carries its own per-import watermarks. The
        // former `isFirstCrossrefRun` flag went with them: "both crossref
        // tables are empty" is the wrong first-run test once each import has
        // a watermark of its own, and a missing watermark row already means
        // an unbounded fetch for exactly that import.

        await updateLastRun(tx, JOB_NAME, runStartedAt);
      });

      console.log(
        `[library-etl] Completed. Inserted ${insertedCount}, updated via legacy-id conflict ${updatedFromLegacyConflictCount}, skipped ${skippedCount}, skipped as deleted ${denylistedCount} (+${denylistedAtWriteTimeCount} caught at write time), resurrections undone ${resurrectionsUndone}.`
      );

      reportStrandedResurrections(strandedResurrections);
    }

    // BS#2424 phase 2. Deliberately OUTSIDE the release-delta branch: the
    // secondary imports carry their own watermarks now, so an idle pass —
    // which is ~98% of runs — must still process a cross-reference-only
    // edit. It runs after phase 1 has COMMITTED, because the imports below
    // resolve against `library` rows phase 1 writes and deletes.
    await runSecondaryImports(runStartedAt);
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
  buildLegacySourcedSetMap,
  buildLegacySourcedSetWhere,
  ensureArtist,
  findArtistId,
  // BS#2424 — the compilation-track batcher and the array splitter it uses.
  // `importCompilationTracks` is exported so a test can pin the STATEMENT
  // COUNT: every other test in this change passes identically against the
  // old row-at-a-time loop, so without this the batching itself — the whole
  // point of BS#2424 — has no regression guard.
  importCompilationTracks,
  chunk,
  // BS#2424 — the delta bounds and the full-pass clock.
  buildArtistCrossRefQuery,
  buildReleaseCrossRefQuery,
  buildCompilationTrackQuery,
  isSecondaryFullPassDue,
};

run().catch((error) => {
  console.error('[library-etl] Failed:', error);
  process.exitCode = 1;
});
