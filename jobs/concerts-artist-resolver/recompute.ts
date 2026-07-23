/**
 * Step 4 of jobs/concerts-artist-resolver's four-step run (BS#1760, parent
 * #1618, On Tour epic #1588): windowed recompute-from-truth for
 * `concerts.has_resolved_support`.
 *
 * Locked decision from the issue: this is a windowed recompute, NOT a
 * same-transaction boolean flip at resolve time. A one-directional flip
 * can't handle the down-transition (tombstone the only resolved support
 * → must go false) without decrement bookkeeping — the exact drift
 * surface a `count` column was rejected to avoid when the substrate
 * landed (migration 0128). Recomputing from truth every run is
 * idempotent, handles resolve AND tombstone/un-tombstone uniformly with
 * the same formula, and is O(upcoming concerts) — hundreds to
 * low-thousands, trivial at this scale.
 *
 * One CTE + one UPDATE, one round-trip. The CTE computes the EXISTS
 * predicate once per candidate row; the UPDATE's `IS DISTINCT FROM` guard
 * means a concert whose flag already matches truth is never rewritten —
 * `last_modified` only advances on a genuine transition, mirroring the
 * `setWhere`-guarded no-op-skip convention used by the concerts writers
 * (venue-events-scraper, triangle-shows-etl).
 *
 * Dual-lane resolved predicate (`artist_id IS NOT NULL OR
 * discogs_artist_id IS NOT NULL`) mirrors the headliner curated
 * predicate — a support act counts as resolved via the library FK
 * (Phase B, this job) OR a bare Discogs id (the future Phase D LML arm).
 *
 * Windowed to the same active set as the sync + support-resolve steps
 * (`concerts.removed_at IS NULL AND starts_on >= todayEastern`) — a
 * concert that ages out of the window keeps whatever `has_resolved_
 * support` value it last had; nothing un-recomputes a past show.
 */

import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const CONCERTS_TABLE = sql.raw(`"${SCHEMA}"."concerts"`);
const CONCERT_PERFORMERS_TABLE = sql.raw(`"${SCHEMA}"."concert_performers"`);

/**
 * Mirrors the identical helper in query.ts / targets.ts / sync-db.ts /
 * support-db.ts — fail LOUD on an unrecognized `db.execute()` result
 * shape rather than silently degrade to a healthy-looking zero-work
 * no-op.
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
  throw new Error(
    `concerts-artist-resolver.recompute: unrecognized db.execute() result shape: ${describeShape(result)}`
  );
};

export type RecomputeOutcome = {
  /** Concerts whose has_resolved_support actually flipped this run. */
  updated: number;
  updated_true: number;
  updated_false: number;
};

type ComputedRow = { resolved: boolean };

export const recomputeHasResolvedSupport = async (): Promise<RecomputeOutcome> => {
  const result: unknown = await db.execute(sql`
    WITH computed AS (
      SELECT
        c."id",
        EXISTS (
          SELECT 1 FROM ${CONCERT_PERFORMERS_TABLE} cp
          WHERE cp."concert_id" = c."id"
            AND cp."role" = 'support'
            AND cp."removed_at" IS NULL
            AND (cp."artist_id" IS NOT NULL OR cp."discogs_artist_id" IS NOT NULL)
        ) AS resolved
      FROM ${CONCERTS_TABLE} c
      WHERE c."removed_at" IS NULL
        AND c."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date
    )
    UPDATE ${CONCERTS_TABLE} c
    SET "has_resolved_support" = computed.resolved,
        "last_modified" = now()
    FROM computed
    WHERE c."id" = computed."id"
      AND c."has_resolved_support" IS DISTINCT FROM computed.resolved
    RETURNING computed.resolved AS resolved
  `);
  const rows = unwrapRows<ComputedRow>(result);
  const updated_true = rows.filter((row) => row.resolved === true).length;
  return { updated: rows.length, updated_true, updated_false: rows.length - updated_true };
};
