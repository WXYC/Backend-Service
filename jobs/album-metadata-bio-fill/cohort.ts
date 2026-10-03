/**
 * Every statement the bio fill issues (BS#2775).
 *
 * Kept apart from `job.ts` so it can be a second tsup entry emitting CommonJS:
 * the integration spec `require`s `dist/cohort.cjs` and runs these statements
 * against real Postgres, rather than testing a hand-copied SQL mirror (the
 * `jobs/station-signup-review` pattern).
 *
 * Each statement is built by a pure `*Sql` function returning text, so the
 * unit suite can pin its shape without a database; the async wrappers below
 * only add the transaction and `statement_timeout`.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

/** Statement timeout for the counts and the enumeration scan. */
export const READ_TIMEOUT_DEFAULT = 5 * 60 * 1000;

// Schema-qualified via `WXYC_SCHEMA_NAME`, never a hardcoded `wxyc_schema.`,
// so the integration tier's per-worker schema is the one these read.
const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const table = (name: string): string => `"${SCHEMA}"."${name}"`;

/**
 * A row that needs a bio, as ONE definition: it carries a real Discogs match
 * and has no `artist_bio`. Reused verbatim by the counts, the enumeration and
 * the UPDATE's WHERE so they can never describe different populations.
 *
 * The `nullif` is load-bearing. The enrichment worker persists `''` in
 * `discogs_url` as its synthetic-match sentinel (BS#1628), and a synthetic
 * match has no Discogs identity to hang a bio on.
 */
export const cohortPredicateSql = (alias = ''): string => {
  const q = (col: string) => (alias ? `${alias}."${col}"` : `"${col}"`);
  return `nullif(${q('discogs_url')}, '') IS NOT NULL\n       AND ${q('artist_bio')} IS NULL`;
};

export const countCohortSql = (): string =>
  `SELECT count(*)::int AS n FROM ${table('album_metadata')} WHERE ${cohortPredicateSql()}`;

/**
 * The artist name sent to LML. `library.artist_name` first, then `artists` —
 * the catalog export's order, NOT `streaming-columns-drain`'s. `library.db` is
 * built from that export, so sending the same string keeps LML's
 * request-artist-to-row-artist hop from failing its floor on a row where the
 * two columns differ.
 */
const ARTIST_NAME = `COALESCE(l."artist_name", a."artist_name")`;

/**
 * The drainable subset, as one FROM/WHERE shared by the eligible-count and the
 * enumeration. Drops rows with no usable artist name (`String(null)` would be
 * POSTed as the literal "null") and albums a music director has marked as not
 * on Discogs (BS#1294), which are a guaranteed no-match.
 */
const eligibleFromWhereSql = (): string => `FROM ${table('album_metadata')} am
  JOIN ${table('library')} l ON l."id" = am."album_id"
  LEFT JOIN ${table('artists')} a ON l."artist_id" = a."id"
  WHERE ${cohortPredicateSql('am')}
    AND ${ARTIST_NAME} IS NOT NULL
    AND l."discogs_unavailable" = false`;

export const countEligibleSql = (): string => `SELECT count(*)::int AS n ${eligibleFromWhereSql()}`;

const nonNegativeInt = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`album-metadata-bio-fill: ${name} must be a non-negative integer, got ${String(value)}`);
  }
  return value;
};

/**
 * Enumerate the drainable cohort above `afterAlbumId`, ordered by `album_id`.
 * `limit` 0 means no cap. A non-empty `albumIds` narrows it to those albums
 * (BS#2786): one more conjunct after the shared block, so a listed id is
 * still subject to the cohort predicate and the eligibility conditions, and
 * one that has a bio by now is simply not returned. Every argument is
 * validated because it is interpolated.
 */
export const enumerateCohortSql = (limit: number, afterAlbumId: number, albumIds: readonly number[] = []): string => {
  const cap = nonNegativeInt(limit, 'limit');
  const cursor = nonNegativeInt(afterAlbumId, 'afterAlbumId');
  const only = albumIds.map((id) => nonNegativeInt(id, 'albumIds'));
  return `SELECT am."album_id" AS album_id,
       l."legacy_release_id" AS legacy_release_id,
       ${ARTIST_NAME} AS artist_name,
       l."album_title" AS album_title
  ${eligibleFromWhereSql()}
    AND am."album_id" > ${cursor}${only.length > 0 ? `\n    AND am."album_id" IN (${only.join(', ')})` : ''}
  ORDER BY am."album_id"${cap > 0 ? `\n  LIMIT ${cap}` : ''}`;
};

export interface FillCandidate {
  album_id: number;
  /** The catalog card id — the id space LML's `library_item.id` lives in. */
  legacy_release_id: number;
  artist_name: string;
  album_title: string;
}

/** Run one read inside a transaction so `SET LOCAL statement_timeout` scopes. */
const read = async <Row>(statement: string, timeoutMs: number): Promise<Row[]> =>
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${nonNegativeInt(timeoutMs, 'timeoutMs')}ms'`));
    return (await tx.execute(sql.raw(statement))) as unknown as Row[];
  });

const countOf = async (statement: string, timeoutMs: number): Promise<number> =>
  Number((await read<{ n: number }>(statement, timeoutMs))[0]?.n ?? 0);

/** Every bio-less Discogs-matched row, drainable or not. */
export const countCohort = (timeoutMs: number = READ_TIMEOUT_DEFAULT): Promise<number> =>
  countOf(countCohortSql(), timeoutMs);

/** The drainable subset, ignoring the cap and the cursor. */
export const countEligible = (timeoutMs: number = READ_TIMEOUT_DEFAULT): Promise<number> =>
  countOf(countEligibleSql(), timeoutMs);

export interface EnumerateOptions {
  /** 0 is no cap. */
  limit: number;
  afterAlbumId: number;
  /** Non-empty narrows the enumeration to these albums (BS#2786). */
  albumIds?: readonly number[];
  timeoutMs?: number;
}

/** Named options rather than positions: `albumIds` and `timeoutMs` are both
 * optional, so a positional list had to pass `undefined` to reach the ids. */
export const enumerateCohort = async ({
  limit,
  afterAlbumId,
  albumIds = [],
  timeoutMs = READ_TIMEOUT_DEFAULT,
}: EnumerateOptions): Promise<FillCandidate[]> => {
  const rows = await read<FillCandidate>(enumerateCohortSql(limit, afterAlbumId, albumIds), timeoutMs);
  return rows.map((r) => ({
    album_id: Number(r.album_id),
    legacy_release_id: Number(r.legacy_release_id),
    artist_name: String(r.artist_name),
    album_title: String(r.album_title),
  }));
};

// -- The write ---------------------------------------------------------------

export interface BioFill {
  artist_bio: string;
  artist_wikipedia_url: string | null;
}

/**
 * Write one album's bio, fill-null only. Returns true when a row changed.
 *
 * The cohort predicate is re-asserted in the WHERE, which is the TOCTOU guard:
 * if anything gave the row a bio between enumeration and write, zero rows
 * match and the caller counts it as raced rather than overwriting. That makes
 * the COALESCE on `artist_bio` redundant; it is kept so the statement reads as
 * fill-null on its face. The COALESCE on `artist_wikipedia_url` is not
 * redundant — the predicate says nothing about that column, and an existing
 * URL must survive.
 *
 * Nothing else on the row is touched. LML resolves by search and often lands
 * on a different release than the stored one, so the release-scoped columns
 * are not this job's to write.
 */
export const applyBioFill = async (albumId: number, fill: BioFill): Promise<boolean> => {
  const rows = (await db.execute(sql`
    UPDATE ${sql.raw(table('album_metadata'))}
       SET "artist_bio"           = COALESCE("artist_bio", ${fill.artist_bio}),
           "artist_wikipedia_url" = COALESCE("artist_wikipedia_url", ${fill.artist_wikipedia_url}),
           "updated_at"           = NOW()
     WHERE "album_id" = ${albumId}
       AND ${sql.raw(cohortPredicateSql())}
    RETURNING "album_id"
  `)) as unknown as Array<{ album_id: number }>;
  return rows.length > 0;
};

/** ANALYZE after a run that wrote, per `docs/bulk-update-playbook.md`. */
export const analyzeAlbumMetadata = async (): Promise<void> => {
  await db.execute(sql.raw(`ANALYZE ${table('album_metadata')}`));
};
