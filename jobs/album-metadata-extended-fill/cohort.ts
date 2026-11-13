/**
 * Every statement the extended fill issues (BS#1442). Also built as
 * `dist/cohort.cjs` so the integration spec runs these against real Postgres
 * (the `album-metadata-bio-fill` pattern); each is a pure `*Sql` function so
 * the unit suite can pin its text.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';
import { EXTENDED_COLUMNS, type ExtendedColumn } from './map.js';

/** Statement timeout for the counts and the enumeration scan. */
export const READ_TIMEOUT_DEFAULT = 5 * 60 * 1000;

// Via `WXYC_SCHEMA_NAME`, so the integration tier's per-worker schema is read.
const SCHEMA = `"${(process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""')}"`;
const TABLE = `${SCHEMA}."album_metadata"`;

/** "Still fillable": `bio_tokens` only beside a bio, since tokens are never written without one. */
const missingSql = (column: ExtendedColumn): string =>
  column === 'bio_tokens' ? `("bio_tokens" IS NULL AND "artist_bio" IS NOT NULL)` : `"${column}" IS NULL`;

/** A row this job can add to: its `discogs_url` names a release (the bounds
 * `parseDiscogsReleaseId` accepts), its album is not marked as not on Discogs
 * (BS#1294, as the bio fill excludes), and a column is still fillable. Rows
 * with no release URL are BS#3136's. */
export const cohortPredicateSql = (): string =>
  `"discogs_url" ~ '/release/[1-9][0-9]{0,8}(?![0-9])'
       AND NOT EXISTS (SELECT 1 FROM ${SCHEMA}."library" l
                        WHERE l."id" = "album_metadata"."album_id" AND l."discogs_unavailable")
       AND ("tracklist" IS NULL OR "genres" IS NULL OR "styles" IS NULL OR "label" IS NULL
         OR "full_release_date" IS NULL OR "discogs_artist_id" IS NULL
         OR "artist_image_url" IS NULL
         OR ${missingSql('bio_tokens')})`;

/** The cohort size and, per column, how many cohort rows still lack it. */
export const cohortStatsSql = (): string =>
  `SELECT count(*)::int AS cohort,
       ${EXTENDED_COLUMNS.map((c) => `count(*) FILTER (WHERE ${missingSql(c)})::int AS ${c}`).join(',\n       ')}
  FROM ${TABLE}
 WHERE ${cohortPredicateSql()}`;

const nonNegativeInt = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`album-metadata-extended-fill: ${name} must be a non-negative integer, got ${String(value)}`);
  }
  return value;
};

/**
 * The cohort above `afterAlbumId` in `album_id` order; `limit` 0 is no cap. A
 * non-empty `albumIds` with no cursor is just those ids (a retry); with one,
 * those ids plus everything above it. Arguments are validated: they are interpolated.
 */
export const enumerateCohortSql = (limit: number, afterAlbumId: number, albumIds: readonly number[] = []): string => {
  const cap = nonNegativeInt(limit, 'limit');
  const cursor = nonNegativeInt(afterAlbumId, 'afterAlbumId');
  const listed = `"album_id" IN (${albumIds.map((id) => nonNegativeInt(id, 'albumIds')).join(', ')})`;
  const range =
    albumIds.length === 0
      ? `"album_id" > ${cursor}`
      : cursor === 0
        ? `"album_id" > 0\n    AND ${listed}`
        : `("album_id" > ${cursor} OR ${listed})`;
  const missing = EXTENDED_COLUMNS.map((c) => `CASE WHEN ${missingSql(c)} THEN '${c}' END`).join(', ');
  return `SELECT "album_id" AS album_id,
       "discogs_url" AS discogs_url,
       "artist_bio" IS NOT NULL AS has_bio,
       "artist_wikipedia_url" IS NOT NULL AS has_wikipedia_url,
       (SELECT l."legacy_release_id" FROM ${SCHEMA}."library" l WHERE l."id" = "album_metadata"."album_id") AS legacy_release_id,
       array_remove(ARRAY[${missing}]::text[], NULL) AS missing
  FROM ${TABLE}
 WHERE ${cohortPredicateSql()}
   AND ${range}
 ORDER BY "album_id"${cap > 0 ? `\n LIMIT ${cap}` : ''}`;
};

export interface FillCandidate {
  album_id: number;
  /** The stored URL: the release to read, and the write's guard. */
  discogs_url: string;
  has_bio: boolean;
  has_wikipedia_url: boolean;
  /** The columns still fillable on this row. */
  missing: ExtendedColumn[];
  /** `library.legacy_release_id`, the id space LML's release pins are keyed in; null when the row has none. */
  legacy_release_id: number | null;
}

export type CohortStats = { cohort: number } & Record<ExtendedColumn, number>;

/** One read inside a transaction so `SET LOCAL statement_timeout` scopes. */
const read = async <Row>(statement: string, timeoutMs: number): Promise<Row[]> =>
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${nonNegativeInt(timeoutMs, 'timeoutMs')}ms'`));
    return (await tx.execute(sql.raw(statement))) as unknown as Row[];
  });

/** Cohort size and per-column gaps, ignoring the cap and the cursor. */
export const cohortStats = async (timeoutMs: number = READ_TIMEOUT_DEFAULT): Promise<CohortStats> => {
  const [row] = await read<Record<string, number>>(cohortStatsSql(), timeoutMs);
  const keys = ['cohort', ...EXTENDED_COLUMNS] as const;
  return Object.fromEntries(keys.map((k) => [k, Number(row?.[k] ?? 0)])) as CohortStats;
};

export interface EnumerateOptions {
  /** 0 is no cap. */
  limit: number;
  afterAlbumId: number;
  albumIds?: readonly number[];
  timeoutMs?: number;
}

/** The cohort rows one run processes. See `enumerateCohortSql`. */
export const enumerateCohort = async (options: EnumerateOptions): Promise<FillCandidate[]> => {
  const { limit, afterAlbumId, albumIds = [], timeoutMs = READ_TIMEOUT_DEFAULT } = options;
  const rows = await read<FillCandidate>(enumerateCohortSql(limit, afterAlbumId, albumIds), timeoutMs);
  return rows.map((r) => ({
    album_id: Number(r.album_id),
    discogs_url: String(r.discogs_url),
    has_bio: Boolean(r.has_bio),
    has_wikipedia_url: Boolean(r.has_wikipedia_url),
    missing: [...(r.missing ?? [])],
    legacy_release_id: r.legacy_release_id === null ? null : Number(r.legacy_release_id),
  }));
};
