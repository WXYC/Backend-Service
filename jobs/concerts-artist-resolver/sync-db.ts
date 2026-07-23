/**
 * DB I/O for the sync step (sync.ts) of jobs/concerts-artist-resolver's
 * four-step run (BS#1760).
 *
 * `loadSyncCandidates` runs two independent SELECTs rather than one JOIN
 * + json_agg: (1) upcoming, non-tombstoned concerts and their current
 * `supporting_artists_raw` array, (2) their existing role='support'
 * `concert_performers` rows (active AND tombstoned — the diff needs to
 * see both). Both queries repeat the SAME `concerts.removed_at IS NULL
 * AND starts_on >= today` predicate independently — per the BS#1760
 * issue, `concert_performers` doesn't carry its parent concert's
 * tombstone (the `ON DELETE CASCADE` only fires on a hard delete, which
 * rarely happens; soft-delete is the norm). Two flat queries zipped
 * client-side, rather than one aggregating JOIN, keeps both predicates
 * textually independent (so an editor diff can't silently drop one half)
 * and avoids relying on `json_agg`'s driver-specific parsing.
 *
 * `applySyncDiff` issues up to three guarded Drizzle-typed-builder calls
 * — one per non-empty bucket of a `SyncDiff` — inside one transaction per
 * concert. `role: 'support'` is spelled as a plain string on the INSERT;
 * Drizzle resolves it against the column's `concert_performer_role_enum`
 * type from the schema, so no explicit cast or enum import is needed
 * here (mirrors how `venue-events-scraper` writer.ts's typed inserts
 * handle `concertStatusEnum` the same way).
 */

import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, concertPerformers } from '@wxyc/database';

import type { ExistingPerformerRow, SyncCandidate, SyncDiff } from './sync.js';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const CONCERTS_TABLE = sql.raw(`"${SCHEMA}"."concerts"`);
const CONCERT_PERFORMERS_TABLE = sql.raw(`"${SCHEMA}"."concert_performers"`);

/**
 * Normalize `db.execute(sql\`...\`)` results across drizzle-orm driver
 * shapes. Mirrors the identical helper in query.ts / targets.ts — fail
 * LOUD on an unrecognized shape rather than silently degrade to a
 * healthy-looking zero-work no-op.
 */
const describeShape = (result: unknown): string => {
  if (result === null) return 'null';
  if (result === undefined) return 'undefined';
  if (typeof result !== 'object') return typeof result;
  return `object{${Object.keys(result).join(',')}}`;
};

const unwrapRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error(`concerts-artist-resolver.sync: unrecognized db.execute() result shape: ${describeShape(result)}`);
};

type ConcertRow = { concert_id: number; supporting_artists_raw: string[] };
type ExistingRow = { concert_id: number; raw_name: string; removed_at: string | Date | null };

/**
 * Both SELECTs below spell out `removed_at IS NULL AND starts_on >= ...`
 * as plain literal text rather than sharing one `sql` fragment. A shared
 * fragment interpolated under a table alias (`c.${fragment}`) would need
 * every column inside it to already be alias-qualified to stay
 * unambiguous once the second query joins `concert_performers` —  which
 * ALSO has its own `removed_at` column. Two independent, fully-qualified
 * copies are more verbose but never silently ambiguous.
 */
export const loadSyncCandidates = async (): Promise<SyncCandidate[]> => {
  const concertsResult: unknown = await db.execute(sql`
    SELECT "id" AS concert_id, "supporting_artists_raw"
    FROM ${CONCERTS_TABLE}
    WHERE "removed_at" IS NULL
      AND "starts_on" >= (now() AT TIME ZONE 'America/New_York')::date
    ORDER BY "id" ASC
  `);
  const concertRows = unwrapRows<ConcertRow>(concertsResult);

  const existingResult: unknown = await db.execute(sql`
    SELECT cp."concert_id" AS concert_id, cp."raw_name" AS raw_name, cp."removed_at" AS removed_at
    FROM ${CONCERT_PERFORMERS_TABLE} cp
    JOIN ${CONCERTS_TABLE} c ON c."id" = cp."concert_id"
    WHERE cp."role" = 'support'
      AND c."removed_at" IS NULL
      AND c."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date
    ORDER BY cp."concert_id" ASC
  `);
  const existingRows = unwrapRows<ExistingRow>(existingResult);

  const existingByConcert = new Map<number, ExistingPerformerRow[]>();
  for (const row of existingRows) {
    const entry: ExistingPerformerRow = { raw_name: row.raw_name, removed_at: row.removed_at };
    const list = existingByConcert.get(row.concert_id);
    if (list) {
      list.push(entry);
    } else {
      existingByConcert.set(row.concert_id, [entry]);
    }
  }

  return concertRows.map((row) => ({
    concert_id: row.concert_id,
    supporting_artists_raw: row.supporting_artists_raw,
    existing: existingByConcert.get(row.concert_id) ?? [],
  }));
};

export const applySyncDiff = async (
  concertId: number,
  diff: SyncDiff
): Promise<{ inserted: number; untombstoned: number; tombstoned: number }> => {
  return db.transaction(async (tx) => {
    let inserted = 0;
    let untombstoned = 0;
    let tombstoned = 0;

    if (diff.to_insert.length > 0) {
      const rows = await tx
        .insert(concertPerformers)
        .values(diff.to_insert.map((raw_name) => ({ concert_id: concertId, raw_name, role: 'support' as const })))
        .onConflictDoNothing({
          target: [concertPerformers.concert_id, concertPerformers.role, concertPerformers.raw_name],
        })
        .returning({ id: concertPerformers.id });
      inserted = rows.length;
    }

    if (diff.to_untombstone.length > 0) {
      const rows = await tx
        .update(concertPerformers)
        .set({ removed_at: null })
        .where(
          and(
            eq(concertPerformers.concert_id, concertId),
            eq(concertPerformers.role, 'support'),
            isNotNull(concertPerformers.removed_at),
            inArray(concertPerformers.raw_name, diff.to_untombstone)
          )
        )
        .returning({ id: concertPerformers.id });
      untombstoned = rows.length;
    }

    if (diff.to_tombstone.length > 0) {
      const rows = await tx
        .update(concertPerformers)
        .set({ removed_at: sql`now()` })
        .where(
          and(
            eq(concertPerformers.concert_id, concertId),
            eq(concertPerformers.role, 'support'),
            isNull(concertPerformers.removed_at),
            inArray(concertPerformers.raw_name, diff.to_tombstone)
          )
        )
        .returning({ id: concertPerformers.id });
      tombstoned = rows.length;
    }

    return { inserted, untombstoned, tombstoned };
  });
};
