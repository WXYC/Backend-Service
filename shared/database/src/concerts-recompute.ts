/**
 * Windowed recompute-from-truth for `concerts.has_resolved_support`
 * (BS#1760, extracted to @wxyc/database by BS#1763 — parent #1618, On Tour
 * epic #1588).
 *
 * Shared by BOTH support-resolving jobs — `jobs/concerts-artist-resolver`'s
 * pure-SQL strict/alias arm (step 4 of its four-step run) and
 * `jobs/concerts-artist-lml-resolver`'s LML verify-before-mint
 * `supportTarget` — so a support resolved by EITHER lane flips the boolean
 * the SAME cron cycle it resolves in, with no one-cycle lag. Lives here
 * (not in either job) because jobs are separate npm workspaces and must not
 * reach into one another's internals; this mirrors `live-activity.ts` (a
 * full round-trip helper shared across ~15 jobs) and `concerts-sql.ts` (SQL
 * shared across the concerts writers) — the established precedent for
 * concerts-domain logic used by multiple jobs.
 *
 * `jobs/concerts-artist-resolver/recompute.ts` is now a thin re-export
 * shim pointing here (à la the `@wxyc/legacy-mirror` BS#1707 extraction) so
 * its existing import site and callers stay untouched.
 *
 * Locked decision from the BS#1760 issue: this is a windowed recompute, NOT
 * a same-transaction boolean flip at resolve time. A one-directional flip
 * can't handle the down-transition (tombstone the only resolved support →
 * must go false) without decrement bookkeeping — the exact drift surface a
 * `count` column was rejected to avoid when the substrate landed (migration
 * 0128). Recomputing from truth every run is idempotent, handles resolve
 * AND tombstone/un-tombstone uniformly, and is O(upcoming concerts) —
 * hundreds to low-thousands, trivial at this scale.
 *
 * One CTE + one UPDATE, one round-trip. The CTE computes the EXISTS
 * predicate once per candidate row; the UPDATE's `IS DISTINCT FROM` guard
 * means a concert whose flag already matches truth is never rewritten —
 * `last_modified` only advances on a genuine transition, mirroring the
 * `setWhere`-guarded no-op-skip convention used by the concerts writers
 * (venue-events-scraper, triangle-shows-etl).
 *
 * Dual-lane resolved predicate (`artist_id IS NOT NULL OR
 * discogs_artist_id IS NOT NULL`) mirrors the headliner curated predicate —
 * a support act counts as resolved via the library FK (the pure-SQL arm)
 * OR a bare Discogs id (the LML arm).
 *
 * Windowed to the same active set as the sync + both resolve arms
 * (`concerts.removed_at IS NULL AND starts_on >= todayEastern`) — a
 * concert that ages out of the window keeps whatever `has_resolved_
 * support` value it last had; nothing un-recomputes a past show.
 */

import { sql } from 'drizzle-orm';
import { db } from './client.js';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const CONCERTS_TABLE = sql.raw(`"${SCHEMA}"."concerts"`);
const CONCERT_PERFORMERS_TABLE = sql.raw(`"${SCHEMA}"."concert_performers"`);

/**
 * Mirrors the identical helper in jobs/concerts-artist-resolver/{query,
 * sync-db,support-db}.ts and jobs/concerts-artist-lml-resolver/targets.ts —
 * fail LOUD on an unrecognized `db.execute()` result shape rather than
 * silently degrade to a healthy-looking zero-work no-op.
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
  throw new Error(`concerts-recompute: unrecognized db.execute() result shape: ${describeShape(result)}`);
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
