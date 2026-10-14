/**
 * The re-ask's cohort (BS#3142): `album_metadata` rows whose stored release
 * disagrees with the card's pin (`pin_mismatch`; a URL that does not parse
 * counts) or still stores a pin step 2 removed (`pin_removed`). The pins
 * arrive as files and are bound as arrays; a pin's `library_id` is
 * `library.legacy_release_id`, never `library.id`. Read-only.
 *
 * A second tsup entry (dist/cohort.cjs) so the integration spec runs the real
 * statements. `table()`, `read()` and the cursor are copied from
 * `jobs/album-metadata-bio-fill/cohort.ts` (decision 6 on BS#3137).
 */

import { sql, type SQL } from 'drizzle-orm';
import { db, intArrayLiteral } from '@wxyc/database';

/** `REASK_READ_TIMEOUT_MS` default; the container's 5 s is too short for a 60,700-pin unnest join. */
export const READ_TIMEOUT_DEFAULT = 5 * 60 * 1000;

// `WXYC_SCHEMA_NAME`, so the integration tier's per-worker schema is the one read.
const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const table = (name: string): SQL => sql.raw(`"${SCHEMA}"."${name}"`);

/** One row of the pin export or of step 2's removal file. */
export interface PinRow {
  /** The tubafrenzy card id: `library.legacy_release_id`. */
  library_id: number;
  discogs_release_id: number;
  source: string;
}

export interface CohortInputs {
  pins: readonly PinRow[];
  /** Pins step 2 removed, for cards with no pin now. */
  removed: readonly PinRow[];
}

export type CohortReason = 'pin_mismatch' | 'pin_removed';

export interface ReaskCandidate {
  album_id: number;
  /** The catalog card id — the id space LML's `library_item.id` lives in. */
  legacy_release_id: number;
  discogs_url: string;
  artwork_url: string | null;
  library_artwork_url: string | null;
  /** The release id in `discogs_url`; null when the URL does not parse. */
  stored_release_id: number | null;
  artist_name: string;
  album_title: string;
  reason: CohortReason;
  /** The current pin; null for `pin_removed`. */
  pin_release_id: number | null;
  /** The source of the pin (for `pin_removed`, of the removed pin). */
  pin_source: string;
}

// Copied from `jobs/album-reviews-etl/link.ts`: a `text[]` literal with each
// element quoted, backslashes escaped before quotes.
const quoteArrayElement = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const textArrayLiteral = (values: string[]): string => `{${values.map(quoteArrayElement).join(',')}}`;

/**
 * One `unnest` over three bound array literals: card, release, source. A card
 * named twice would enter the cohort twice, so it is refused here whatever
 * the file parser already checked.
 */
const unnestRows = (rows: readonly PinRow[]): SQL => {
  const seen = new Set<number>();
  for (const { library_id } of rows) {
    if (seen.has(library_id)) throw new Error(`album-metadata-reask: library_id ${library_id} appears twice`);
    seen.add(library_id);
  }
  return sql`unnest(${intArrayLiteral(rows.map((r) => r.library_id))}::int[], ${intArrayLiteral(
    rows.map((r) => r.discogs_release_id)
  )}::int[], ${textArrayLiteral(rows.map((r) => r.source))}::text[])`;
};

/**
 * The CTEs every statement shares. `removed` keeps only cards with no pin
 * now: a card pinned again is judged against its new pin. `range` (the enumeration's cursor) is
 * applied in `stored`, before the regex and the joins. The `nullif` keeps out
 * the `''` synthetic-match sentinel (BS#1628); the artist name follows the
 * catalog export's order, which `library.db` is built from. The release id
 * pattern takes only a whole id that fits `int`, so an oversized one reads as
 * unparseable (a mismatch) instead of aborting the read.
 */
const cohortCtes = (inputs: CohortInputs, range: SQL = sql`TRUE`): SQL => sql`WITH pin AS (
  SELECT * FROM ${unnestRows(inputs.pins)} AS p(legacy_release_id, pin_release_id, pin_source)
), removed AS (
  SELECT * FROM ${unnestRows(inputs.removed)} AS r(legacy_release_id, removed_release_id, pin_source)
   WHERE NOT EXISTS (SELECT 1 FROM pin p WHERE p.legacy_release_id = r.legacy_release_id)
), stored AS (
  SELECT am."album_id" AS album_id,
         l."legacy_release_id" AS legacy_release_id,
         am."discogs_url" AS discogs_url,
         am."artwork_url" AS artwork_url,
         l."artwork_url" AS library_artwork_url,
         substring(am."discogs_url" FROM '/release/([1-9][0-9]{0,8})(?![0-9])')::int AS stored_release_id,
         COALESCE(l."artist_name", a."artist_name") AS artist_name,
         l."album_title" AS album_title,
         l."discogs_unavailable" AS discogs_unavailable
    FROM ${table('album_metadata')} am
    JOIN ${table('library')} l ON l."id" = am."album_id"
    LEFT JOIN ${table('artists')} a ON a."id" = l."artist_id"
   WHERE nullif(am."discogs_url", '') IS NOT NULL
     AND ${range}
), cohort AS (
  SELECT s.*, p.pin_release_id, p.pin_source, 'pin_mismatch' AS reason
    FROM stored s JOIN pin p ON p.legacy_release_id = s.legacy_release_id
   WHERE s.stored_release_id IS DISTINCT FROM p.pin_release_id
  UNION ALL
  SELECT s.*, NULL::int AS pin_release_id, r.pin_source, 'pin_removed' AS reason
    FROM stored s JOIN removed r ON r.legacy_release_id = s.legacy_release_id
   WHERE s.stored_release_id = r.removed_release_id
)`;

/**
 * Counts over the whole cohort, by reason and source, with the eligibility
 * exclusions as filtered counts (first cause wins, so they add up). No artist
 * name cannot happen under today's schema (`library.artist_id` and
 * `artists.artist_name` are NOT NULL); it is counted as a guard. The
 * `removed_stores_other` rows are removed cards whose row stores some other
 * release: the matcher's pick, not the pin's, so not this job's to touch.
 */
export const countCohortSql = (inputs: CohortInputs): SQL => sql`${cohortCtes(inputs)}
SELECT c.reason, c.pin_source, count(*)::int AS n,
       count(*) FILTER (WHERE c.artist_name IS NULL)::int AS no_artist_name,
       count(*) FILTER (WHERE c.artist_name IS NOT NULL AND c.discogs_unavailable)::int AS discogs_unavailable,
       count(*) FILTER (WHERE c.library_artwork_url = c.artwork_url)::int AS cover_mirrors
  FROM cohort c
 GROUP BY c.reason, c.pin_source
UNION ALL
SELECT 'removed_stores_other' AS reason, r.pin_source, count(*)::int, 0, 0, 0
  FROM stored s JOIN removed r ON r.legacy_release_id = s.legacy_release_id
 WHERE s.stored_release_id IS DISTINCT FROM r.removed_release_id
 GROUP BY r.pin_source`;

export interface CountRow {
  reason: CohortReason | 'removed_stores_other';
  pin_source: string;
  n: number;
  no_artist_name: number;
  discogs_unavailable: number;
  cover_mirrors: number;
}

export interface CohortCounts {
  /** Every cohort row, drainable or not. */
  total: number;
  /** The drainable subset: has an artist name, not marked off Discogs. */
  eligible: number;
  by_reason_and_source: Array<{ reason: CohortReason; source: string; n: number }>;
  excluded: { no_artist_name: number; discogs_unavailable: number; removed_stores_other: number };
  /** Cohort albums whose catalog cover equals the stored cover. */
  catalog_cover_mirrors: number;
}

/** Fold the count rows into the summary the dry run logs. */
export const tallyCounts = (rows: readonly CountRow[]): CohortCounts => {
  const counts: CohortCounts = {
    total: 0,
    eligible: 0,
    by_reason_and_source: [],
    excluded: { no_artist_name: 0, discogs_unavailable: 0, removed_stores_other: 0 },
    catalog_cover_mirrors: 0,
  };
  for (const row of rows) {
    if (row.reason === 'removed_stores_other') {
      counts.excluded.removed_stores_other += row.n;
      continue;
    }
    counts.total += row.n;
    counts.eligible += row.n - row.no_artist_name - row.discogs_unavailable;
    counts.by_reason_and_source.push({ reason: row.reason, source: row.pin_source, n: row.n });
    counts.excluded.no_artist_name += row.no_artist_name;
    counts.excluded.discogs_unavailable += row.discogs_unavailable;
    counts.catalog_cover_mirrors += row.cover_mirrors;
  }
  return counts;
};

const checkedInt = (value: number, name: string, min = 0): number => {
  if (!Number.isInteger(value) || value < min) {
    const kind = min > 0 ? 'positive' : 'non-negative';
    throw new Error(`album-metadata-reask: ${name} must be a ${kind} integer, got ${String(value)}`);
  }
  return value;
};

export interface EnumerateOptions {
  /** 0 is no cap. */
  limit: number;
  afterAlbumId: number;
  /** Carried ids. With cursor 0 they are the whole run (a retry); with a cursor, asked on top of it. */
  albumIds?: readonly number[];
  timeoutMs?: number;
}

/**
 * The drainable cohort above the cursor, ordered by `album_id`. A listed id
 * is still subject to the cohort predicate and the eligibility conditions, so
 * one that has left the cohort is simply not returned.
 */
export const enumerateCohortSql = (
  inputs: CohortInputs,
  { limit, afterAlbumId, albumIds = [] }: EnumerateOptions
): SQL => {
  const cap = checkedInt(limit, 'limit');
  const cursor = checkedInt(afterAlbumId, 'afterAlbumId');
  const listed = sql`am."album_id" = ANY(${intArrayLiteral(albumIds.map((id) => checkedInt(id, 'albumIds')))}::int[])`;
  const range =
    albumIds.length === 0
      ? sql`am."album_id" > ${cursor}`
      : cursor === 0
        ? listed
        : sql`(am."album_id" > ${cursor} OR ${listed})`;
  return sql`${cohortCtes(inputs, range)}
SELECT c.album_id, c.legacy_release_id, c.discogs_url, c.artwork_url, c.library_artwork_url,
       c.stored_release_id, c.artist_name, c.album_title, c.reason, c.pin_release_id, c.pin_source
  FROM cohort c
 WHERE c.artist_name IS NOT NULL AND c.discogs_unavailable = false
 ORDER BY c.album_id${cap > 0 ? sql` LIMIT ${cap}` : sql``}`;
};

/** Run one read inside a transaction so `SET LOCAL statement_timeout` scopes. 0 would disable it, so it is refused. */
const read = async <Row>(statement: SQL, timeoutMs: number): Promise<Row[]> => {
  const timeout = checkedInt(timeoutMs, 'timeoutMs', 1);
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeout}ms'`));
    return (await tx.execute(statement)) as unknown as Row[];
  });
};

export const countCohort = async (
  inputs: CohortInputs,
  timeoutMs: number = READ_TIMEOUT_DEFAULT
): Promise<CohortCounts> => tallyCounts(await read<CountRow>(countCohortSql(inputs), timeoutMs));

const numberOrNull = (value: unknown): number | null => (value === null ? null : Number(value));

export const enumerateCohort = async (inputs: CohortInputs, options: EnumerateOptions): Promise<ReaskCandidate[]> => {
  const rows = await read<Record<string, unknown>>(
    enumerateCohortSql(inputs, options),
    options.timeoutMs ?? READ_TIMEOUT_DEFAULT
  );
  return rows.map((r) => ({
    album_id: Number(r.album_id),
    legacy_release_id: Number(r.legacy_release_id),
    discogs_url: String(r.discogs_url),
    artwork_url: r.artwork_url as string | null,
    library_artwork_url: r.library_artwork_url as string | null,
    stored_release_id: numberOrNull(r.stored_release_id),
    artist_name: String(r.artist_name),
    album_title: String(r.album_title),
    reason: r.reason as CohortReason,
    pin_release_id: numberOrNull(r.pin_release_id),
    pin_source: String(r.pin_source),
  }));
};
