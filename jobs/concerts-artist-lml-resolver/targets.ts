/**
 * Role targets for jobs/concerts-artist-lml-resolver: `headlinerTarget`
 * (BS#1614) and `supportTarget` (BS#1763, parent #1618, On Tour epic
 * #1588).
 *
 * Each owns one half of the role-agnostic contract in orchestrate.ts: which
 * rows are candidates, and how a verdict lands on them. `supportTarget` is
 * the concerts-artist-resolver's dual (this file's sibling job resolves
 * `concerts.headlining_artist_raw`; concerts-artist-resolver's own
 * `support-db.ts` resolves `concert_performers` via the pure-SQL
 * strict/alias arm) extended to the LML lane — registered alongside
 * `headlinerTarget` in job.ts's `targets` array, so a name billed as both a
 * headliner and a support act resolves ONCE and fans to both (orchestrate.ts's
 * per-name dedupe is keyed across ALL registered targets, not per-target).
 *
 * Candidate predicate (upcoming-only is deliberate — never burn Discogs
 * budget resolving past shows). Headliner (`concerts`):
 *
 *   headlining_artist_id IS NULL          -- SQL arm hasn't FK'd it
 *   AND headlining_discogs_artist_id IS NULL  -- this arm hasn't either
 *   AND headlining_artist_raw IS NOT NULL
 *   AND (title IS NULL OR title !~* '\mtribute')  -- tribute guard (see below)
 *   AND headlining_artist_raw !~* '\mtribute'     -- tribute guard (see below)
 *   AND removed_at IS NULL
 *   AND starts_on >= (now() AT TIME ZONE 'America/New_York')::date
 *   AND (artist_resolve_attempted_at IS NULL   -- never-asked / retryable
 *        OR artist_resolve_attempted_at < now() - TTL)  -- no-match re-ask
 *
 * The tribute guard mirrors the SQL lane (jobs/concerts-artist-resolver/
 * query.ts): in a tribute-framed event the billed name belongs to — or
 * aliases — the HONOREE, not the performer, so any identity either lane
 * could mint for it is a mislabel by construction (the Stanczyks "REM
 * Tribute to Lifes Rich Pageant" incident). Word-start match (\m) so a
 * name like "Tributaries" doesn't trip it; the title arm is NULL-safe.
 *
 * Support (`concert_performers` joined to `concerts`):
 *
 *   cp.artist_id IS NULL              -- pure-SQL arm hasn't FK'd it
 *   AND cp.discogs_artist_id IS NULL  -- this arm hasn't either
 *   AND cp.removed_at IS NULL
 *   AND cp.role = 'support'
 *   AND cp.raw_name !~* '\mtribute'   -- RAW-NAME-ONLY tribute guard (see below)
 *   AND c.removed_at IS NULL
 *   AND c.starts_on >= (now() AT TIME ZONE 'America/New_York')::date
 *   AND (cp.artist_resolve_attempted_at IS NULL
 *        OR cp.artist_resolve_attempted_at < now() - TTL)
 *
 * The support tribute guard is RAW-NAME-ONLY — deliberately NOT the
 * headliner arm's additional `title !~* '\mtribute'` exclusion. A concert's
 * title frames the HEADLINER slot; a support act billed at a tribute-titled
 * show is a real opener, not a mislabeled honoree. Matches the raw-name-only
 * guard `jobs/concerts-artist-resolver/support-db.ts`'s Phase-B arm already
 * uses, per the BS#1760 issue's locked decision.
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
 * `headlining_artist_id` (headliner) / `concert_performers.artist_id`
 * (support) — a touring artist billed under a name the alias substrate
 * doesn't know, but whose Discogs identity we already have. Both targets
 * share the one `lookupSingletonLibraryArtistId` check below (LIMIT 2,
 * mirror of the strict resolver's collapse-on-ambiguous) — it is
 * load-bearing: `artists.discogs_artist_id` has NO unique constraint
 * (duplicates exist via the identity ETL), and FK'ing an arbitrary
 * duplicate would mislabel the concert or performer.
 *
 * `has_resolved_support`: neither target's write touches this column —
 * it's a windowed recompute-from-truth (`recomputeHasResolvedSupport`,
 * `@wxyc/database`, shared with `jobs/concerts-artist-resolver`'s own step
 * 4), called once by job.ts after `runResolve` finishes so a support this
 * run resolved (discogs-only or FK-closed) is curated the SAME cron cycle,
 * not one cycle later.
 *
 * Schema-qualified refs honour `WXYC_SCHEMA_NAME` (parallel Jest workers
 * override it so each worker targets its own schema).
 */

import { and, inArray, isNull, sql } from 'drizzle-orm';
import { concertPerformers, concerts, db } from '@wxyc/database';

import type { ResolvedVerdict, RoleTarget, TargetCandidate } from './orchestrate.js';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const CONCERTS_TABLE = sql.raw(`"${SCHEMA}"."concerts"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);
const CONCERT_PERFORMERS_TABLE = sql.raw(`"${SCHEMA}"."concert_performers"`);

/** Provenance written to `concerts.headlining_discogs_artist_id_source`. */
export const HEADLINER_MATCH_SOURCE = 'lml_artist_resolve';

/** Provenance written to `concert_performers.discogs_artist_id_source`.
 *  Same literal value as {@link HEADLINER_MATCH_SOURCE} — both columns are
 *  resolved by this same job via the same LML#759 endpoint — kept as a
 *  separate exported constant so either role's provenance string can
 *  diverge later without touching the other. */
export const SUPPORT_MATCH_SOURCE = 'lml_artist_resolve';

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
      AND ("title" IS NULL OR "title" !~* '\\mtribute')
      AND "headlining_artist_raw" !~* '\\mtribute'
      AND "removed_at" IS NULL
      AND "starts_on" >= (now() AT TIME ZONE 'America/New_York')::date
      AND ("artist_resolve_attempted_at" IS NULL
        OR "artist_resolve_attempted_at" < now() - (interval '1 day' * ${ttlDays}))
    ORDER BY "id" ASC
  `);
  return unwrapRows<TargetCandidate>(result);
};

/**
 * Volume: bounded by the same small upcoming-concert window as the
 * headliner candidate set, times `SUPPORT_MAX_COUNT` (32) acts per concert
 * (see `jobs/concerts-artist-resolver/support-db.ts`) — full-set-in-memory
 * is fine at this scale.
 */
export const loadSupportCandidates = async (ttlDays: number): Promise<TargetCandidate[]> => {
  const result: unknown = await db.execute(sql`
    SELECT cp."id", cp."raw_name" AS raw_name
    FROM ${CONCERT_PERFORMERS_TABLE} cp
    JOIN ${CONCERTS_TABLE} c ON c."id" = cp."concert_id"
    WHERE cp."artist_id" IS NULL
      AND cp."discogs_artist_id" IS NULL
      AND cp."removed_at" IS NULL
      AND cp."role" = 'support'
      AND cp."raw_name" !~* '\\mtribute'
      AND c."removed_at" IS NULL
      AND c."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date
      AND (cp."artist_resolve_attempted_at" IS NULL
        OR cp."artist_resolve_attempted_at" < now() - (interval '1 day' * ${ttlDays}))
    ORDER BY cp."id" ASC
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

/**
 * Support role-target (BS#1763): resolves `concert_performers` rows
 * (role='support') the pure-SQL strict/alias arm
 * (`jobs/concerts-artist-resolver/support-db.ts`) couldn't FK — touring
 * openers absent from the WXYC library, mirroring `headlinerTarget` above
 * but writing `concert_performers.discogs_artist_id` /
 * `concert_performers.artist_id` instead of the `concerts.headlining_*`
 * columns. Registered alongside `headlinerTarget` in job.ts's `targets`
 * array; orchestrate.ts's per-name dedupe is what makes a name billed as
 * both a headliner and a support act resolve exactly once.
 *
 * Does NOT touch `has_resolved_support` — see the file-level docblock's
 * note above; job.ts calls the shared `recomputeHasResolvedSupport` once
 * after `runResolve` finishes.
 */
export const supportTarget: RoleTarget = {
  role: 'support',

  loadCandidates: loadSupportCandidates,

  applyResolved: async (rowIds: number[], verdict: ResolvedVerdict) => {
    const fkArtistId = await lookupSingletonLibraryArtistId(verdict.discogs_artist_id);
    const updated = await db
      .update(concertPerformers)
      .set({
        discogs_artist_id: verdict.discogs_artist_id,
        discogs_artist_id_source: SUPPORT_MATCH_SOURCE,
        artist_resolve_attempted_at: sql`now()`,
        // Spread-conditional so a non-singleton NEVER puts the FK column in
        // the SET clause at all — there is no code path that writes an
        // arbitrary duplicate.
        ...(fkArtistId === null ? {} : { artist_id: fkArtistId }),
      })
      .where(
        and(
          inArray(concertPerformers.id, rowIds),
          isNull(concertPerformers.artist_id),
          isNull(concertPerformers.discogs_artist_id)
        )
      )
      .returning({ id: concertPerformers.id });
    return {
      updated: updated.length,
      fk_loop_closed: fkArtistId === null ? 0 : updated.length,
    };
  },

  applyNoMatch: async (rowIds: number[]) => {
    const updated = await db
      .update(concertPerformers)
      .set({ artist_resolve_attempted_at: sql`now()` })
      .where(
        and(
          inArray(concertPerformers.id, rowIds),
          isNull(concertPerformers.artist_id),
          isNull(concertPerformers.discogs_artist_id)
        )
      )
      .returning({ id: concertPerformers.id });
    return { updated: updated.length };
  },
};
