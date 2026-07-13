/**
 * Headliner role-target for jobs/concerts-artist-lml-resolver (BS#1614).
 *
 * Owns the concerts-headliner half of the role-agnostic contract in
 * orchestrate.ts: which rows are candidates, and how a verdict lands on
 * them. BS#1618 Phase D adds a sibling target for `concert_performers`
 * junction rows in this file.
 *
 * Candidate predicate (upcoming-only is deliberate — never burn Discogs
 * budget resolving past shows):
 *
 *   headlining_artist_id IS NULL          -- SQL arm hasn't FK'd it
 *   AND headlining_discogs_artist_id IS NULL  -- this arm hasn't either
 *   AND headlining_artist_raw IS NOT NULL
 *   AND removed_at IS NULL
 *   AND starts_on >= (now() AT TIME ZONE 'America/New_York')::date
 *   AND (artist_resolve_attempted_at IS NULL   -- never-asked / retryable
 *        OR artist_resolve_attempted_at < now() - TTL)  -- no-match re-ask
 *
 * The upcoming-only bound is the venue-local (Eastern) calendar date, not
 * server-clock `CURRENT_DATE`. `starts_on` is a venue-local date, so a UTC
 * "today" would flip the window at 8 PM Eastern and briefly drop tonight's
 * shows — the exact reason the read path derives its window from
 * `todayEastern()` (apps/backend/controllers/concerts.controller.ts). Matching
 * that here keeps the candidate window identical to the feed's, independent of
 * the DB server's timezone or when the cron happens to fire.
 *
 * Write fan-out targets the candidate row ids, guarded by BOTH id columns
 * being still NULL, so the job only fills NULLs and a row the 05:15 SQL
 * resolver claimed mid-run is left untouched (data-safety rule; surfaces
 * as the orchestrator's `raced` counter).
 *
 * FK loop-close: when the resolved Discogs id maps to EXACTLY ONE
 * `artists.discogs_artist_id` row, the same UPDATE also sets
 * `headlining_artist_id` — a touring artist billed under a name the alias
 * substrate doesn't know, but whose Discogs identity we already have. The
 * singleton check (LIMIT 2, mirror of the strict resolver's
 * collapse-on-ambiguous) is load-bearing: `artists.discogs_artist_id` has
 * NO unique constraint (duplicates exist via the identity ETL), and FK'ing
 * an arbitrary duplicate would mislabel the concert.
 *
 * Schema-qualified refs honour `WXYC_SCHEMA_NAME` (parallel Jest workers
 * override it so each worker targets its own schema).
 */

import { and, inArray, isNull, sql } from 'drizzle-orm';
import { concerts, db } from '@wxyc/database';

import type { ResolvedVerdict, RoleTarget, TargetCandidate } from './orchestrate.js';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const CONCERTS_TABLE = sql.raw(`"${SCHEMA}"."concerts"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);

/** Provenance written to `concerts.headlining_discogs_artist_id_source`. */
export const HEADLINER_MATCH_SOURCE = 'lml_artist_resolve';

/**
 * Normalize `db.execute(sql\`...\`)` results across drizzle-orm driver
 * shapes. postgres-js returns an array; node-postgres returns `{ rows }`.
 * Anything else means the driver contract changed under us — fail LOUD
 * rather than degrade into a healthy-looking zero-work no-op. Mirrors
 * `jobs/concerts-artist-resolver/query.ts`.
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
  throw new Error(`concerts-artist-lml-resolver: unrecognized db.execute() result shape: ${describeShape(result)}`);
};

/**
 * Volume: the export measured ~306 distinct unresolved upcoming raw names
 * (2026-07-13); steady-state the SELECT returns only the newly-scraped
 * trickle plus TTL-expired no-matches. Full-set-in-memory is fine at this
 * scale (same call as `jobs/concerts-artist-resolver/query.ts`).
 */
export const loadHeadlinerCandidates = async (ttlDays: number): Promise<TargetCandidate[]> => {
  const result: unknown = await db.execute(sql`
    SELECT "id", "headlining_artist_raw" AS raw_name
    FROM ${CONCERTS_TABLE}
    WHERE "headlining_artist_id" IS NULL
      AND "headlining_discogs_artist_id" IS NULL
      AND "headlining_artist_raw" IS NOT NULL
      AND "removed_at" IS NULL
      AND "starts_on" >= (now() AT TIME ZONE 'America/New_York')::date
      AND ("artist_resolve_attempted_at" IS NULL
        OR "artist_resolve_attempted_at" < now() - (interval '1 day' * ${ttlDays}))
    ORDER BY "id" ASC
  `);
  return unwrapRows<TargetCandidate>(result);
};

/**
 * The FK-loop-close singleton check. LIMIT 2 mirrors the strict resolver's
 * collapse-on-ambiguous: 0 rows → no library artist (expected for touring
 * acts), 2+ rows → ambiguous duplicate, both return null and the FK stays
 * NULL; only an exact singleton FKs.
 */
export const lookupSingletonLibraryArtistId = async (discogsArtistId: number): Promise<number | null> => {
  const result: unknown = await db.execute(sql`
    SELECT "id"
    FROM ${ARTISTS_TABLE}
    WHERE "discogs_artist_id" = ${discogsArtistId}
    LIMIT 2
  `);
  const rows = unwrapRows<{ id: number }>(result);
  return rows.length === 1 ? rows[0].id : null;
};

export const headlinerTarget: RoleTarget = {
  role: 'headliner',

  loadCandidates: loadHeadlinerCandidates,

  applyResolved: async (rowIds: number[], verdict: ResolvedVerdict) => {
    const fkArtistId = await lookupSingletonLibraryArtistId(verdict.discogs_artist_id);
    const updated = await db
      .update(concerts)
      .set({
        headlining_discogs_artist_id: verdict.discogs_artist_id,
        headlining_discogs_artist_id_source: HEADLINER_MATCH_SOURCE,
        artist_resolve_attempted_at: sql`now()`,
        // Spread-conditional so a non-singleton NEVER puts the FK column in
        // the SET clause at all — there is no code path that writes an
        // arbitrary duplicate.
        ...(fkArtistId === null ? {} : { headlining_artist_id: fkArtistId }),
      })
      .where(
        and(
          inArray(concerts.id, rowIds),
          isNull(concerts.headlining_artist_id),
          isNull(concerts.headlining_discogs_artist_id)
        )
      )
      .returning({ id: concerts.id });
    return {
      updated: updated.length,
      fk_loop_closed: fkArtistId === null ? 0 : updated.length,
    };
  },

  applyNoMatch: async (rowIds: number[]) => {
    const updated = await db
      .update(concerts)
      .set({ artist_resolve_attempted_at: sql`now()` })
      .where(
        and(
          inArray(concerts.id, rowIds),
          isNull(concerts.headlining_artist_id),
          isNull(concerts.headlining_discogs_artist_id)
        )
      )
      .returning({ id: concerts.id });
    return { updated: updated.length };
  },
};
