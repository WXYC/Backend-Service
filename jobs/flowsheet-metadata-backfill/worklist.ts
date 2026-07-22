/**
 * Play-priority work-list for the flowsheet-metadata-backfill drain (BS#1591).
 *
 * Replaces the id-order `loadBatch` cursor's row selection: one SELECT at run
 * start returns every eligible pending row id, ordered by per-artist total
 * plays descending, and the orchestrator drains that list with a monotonic
 * array cursor. Design decisions (see the issue body) implemented here:
 *
 *   - Play-count source is a per-run flowsheet aggregate over ALL track rows
 *     (total popularity, not pending-only) — no semantic-index dependency.
 *     The grouping key is the SQL function `normalize_artist_name(text)`
 *     (migration 0092, IMMUTABLE PARALLEL SAFE; TS twin at
 *     `shared/database/src/normalize-artist-name.ts`) so the key cannot
 *     drift from the rest of the stack.
 *   - "Library artist" for free-text rows = normalized-name membership in
 *     `artists.artist_name` UNION `artist_search_alias.variant` (the BS#1266
 *     substrate, catching name variants). Linked rows (`album_id IS NOT
 *     NULL`) are library by construction and skip the name check.
 *   - The non-library play-floor is query-time only: below-floor rows are
 *     simply absent from the result — no marker stamp, no status change, no
 *     new enum value. An artist that later crosses the floor graduates
 *     automatically on a subsequent run. `playFloor = 0` disables the floor
 *     (the whole eligibility clause is omitted).
 *   - Recency exemption (decision 5, guarding the BS#895 recovery-sweep
 *     role): rows younger than `recencyDays` are always eligible, so
 *     consumer-missed rows of below-floor artists stay sweepable.
 *     `recencyDays = 0` disables the exemption.
 *   - Ordering is `(plays DESC, artist_norm ASC, id ASC)`. The artist_norm
 *     tiebreaker keeps same-artist rows contiguous even when distinct
 *     artists share a play count, concentrating the run-scoped LookupCache
 *     dedup hits; the id tail makes the order fully deterministic.
 *
 * Below-floor accounting: the eligibility disjunction partitions the pending
 * set exactly, so `below_floor_skipped` is computed by SUBTRACTION —
 * `pending_total - worklist_size` — from a cheap COUNT over the pending
 * partial index (#659/#660), not by re-running the expensive CTEs with the
 * complement predicate. The two statements share the `pendingPredicate`
 * fragment so they cannot drift. The count runs FIRST as a cheap defensive
 * guard (see the note at the early-exit below); the two statements are
 * separate snapshots, so a row hard-deleted, marker-stamped by an
 * out-of-band writer (the live CDC worker never writes the marker — it
 * finalizes via `metadata_status`), or aging past the 60s guard in between
 * can skew the subtraction by a few rows. That is why it is clamped at 0
 * and why the retire-criterion docs call the residual approximate — the
 * field is observability, not control flow.
 *
 * Cost: the `plays` CTE is a seq scan + regexp + GROUP BY over ~2.9M track
 * rows and the outer join computes `normalize_artist_name` per pending row.
 * Expected tens of seconds; the job container ships
 * `DB_STATEMENT_TIMEOUT_MS=300000` (Dockerfile.flowsheet-metadata-backfill)
 * so the budget is 5 minutes (measured ~31s cold on prod, 2026-07-16). A
 * build failure aborts the run with zero rows drained and Sentry fires; if
 * it ever becomes PERSISTENT (the realistic cause is a planner regression
 * after an un-ANALYZEd bulk flowsheet UPDATE — see
 * docs/bulk-update-playbook.md), the escalation levers are ANALYZE, raising
 * `DB_STATEMENT_TIMEOUT_MS`, or materializing `plays` into a scratch table
 * (README). Memory: two packed number arrays (~14MB at a 900k cohort)
 * steady-state, with a transient postgres-js row-object peak an order of
 * magnitude smaller than the host's headroom.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@wxyc/database';

/**
 * Schema-qualified references, honoring `WXYC_SCHEMA_NAME` so parallel Jest
 * workers (which override the env var) and any future integration test
 * harness target the right schema. The default `wxyc_schema` matches
 * production. Sanitised against `"` to keep the SQL well-formed.
 * `FLOWSHEET_TABLE` is exported for the orchestrator's batch loader.
 */
const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
export const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);
const ARTIST_SEARCH_ALIAS_TABLE = sql.raw(`"${SCHEMA}"."artist_search_alias"`);
const NORMALIZE_FN = sql.raw(`"${SCHEMA}"."normalize_artist_name"`);

export type WorkList = {
  /** Pending row ids in drain order (plays DESC, artist_norm ASC, id ASC). */
  ids: number[];
  /** Per-artist total plays, aligned index-for-index with `ids`. */
  plays: number[];
  /** Size of the whole pending cohort (floor-blind), for reconciliation. */
  pendingTotal: number;
  /** The deliberate below-floor residual: pendingTotal - ids.length, >= 0. */
  belowFloorSkipped: number;
};

export type BuildWorkListArgs = {
  playFloor: number;
  recencyDays: number;
  partitionFilter: SQL | null;
};

export type BuildWorkListFn = (args: BuildWorkListArgs) => Promise<WorkList>;

/**
 * The canonical pending predicate — the same four clauses the id-cursor
 * drain used (entry_type, artist_name, marker, 60s race guard vs the
 * runtime fire-and-forget UPDATE) plus the optional PARTITION_INDEX /
 * PARTITION_COUNT fragment. Shared by the count and work-list statements so
 * the subtraction-based below-floor count cannot drift from the selection.
 * Both statements alias flowsheet as `f`; the partition fragment's
 * unqualified `"id"` resolves to `f."id"` (no other relation in scope
 * carries an `id` column).
 */
const pendingPredicate = (partitionFilter: SQL | null): SQL => sql`
  f."entry_type" = 'track'
      AND f."artist_name" IS NOT NULL
      AND f."metadata_attempt_at" IS NULL
      AND f."add_time" < now() - interval '60 seconds'
      ${partitionFilter ?? sql``}
`;

type WorkListRow = { id: number | string; plays: number | string };

/**
 * Loud unwrap of a `db.execute` result (same shape-contract rationale as
 * `jobs/concerts-artist-resolver/query.ts:unwrapRows`, where the docstring
 * names the hazard: a silent `[]`/`?? 0` fallback on a driver-contract
 * change turns the cron into a healthy-looking zero-work no-op — green
 * `finished` log, all-zero Sentry span — while the pending cohort piles up.
 * A drizzle/driver upgrade that changes the result shape must crash the run
 * loudly, not drain zero rows forever.) Exported for the orchestrator's
 * batch loader and reconcile UPDATE.
 */
export const unwrapRows = <T>(result: unknown, statement: string): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error(`flowsheet-metadata-backfill: unrecognized db.execute() result shape for ${statement}`);
};

/**
 * Build the run's work-list. Two statements:
 *
 *   1. `COUNT(*)` of the whole pending cohort — served by the partial index
 *      from #659/#660, cheap. NOTE the zero-count early-exit below is a
 *      defensive guard, not a steady-state optimization: with the floor on,
 *      the deliberate below-floor residual keeps this count permanently
 *      non-zero (the pending cohort no longer drains to literal 0), so the
 *      exit fires only in floor-disabled fully-drained worlds, fresh
 *      environments, and CI. A BS#895 hourly re-scope that wants a cheap
 *      no-op probe needs a different key (e.g. an EXISTS over the
 *      recency/linked arms) — this count cannot provide it.
 *   2. The priority SELECT: plays aggregate CTE + library-artists CTE +
 *      pending predicate + eligibility disjunction + priority ORDER BY.
 *
 * The `library_artists` CTE is declared unconditionally but referenced only
 * inside the eligibility clause; when `playFloor` is 0 Postgres never
 * executes the unreferenced CTE, so there is no cost to the simpler
 * single-shape assembly.
 */
export const buildWorkList: BuildWorkListFn = async ({ playFloor, recencyDays, partitionFilter }) => {
  const countRows = unwrapRows<{ pending_total: number | string }>(
    await db.execute(sql`
    SELECT COUNT(*)::int AS pending_total
    FROM ${FLOWSHEET_TABLE} f
    WHERE ${pendingPredicate(partitionFilter)}
  `),
    'pending count'
  );
  if (countRows.length !== 1) {
    throw new Error(`flowsheet-metadata-backfill: pending count returned ${countRows.length} rows; expected 1`);
  }
  const pendingTotal = Number(countRows[0].pending_total);
  if (!Number.isFinite(pendingTotal)) {
    throw new Error(`flowsheet-metadata-backfill: pending count returned non-numeric ${JSON.stringify(countRows[0])}`);
  }

  if (pendingTotal === 0) {
    return { ids: [], plays: [], pendingTotal: 0, belowFloorSkipped: 0 };
  }

  // Recency arm (decision 5): rows younger than `recencyDays` are always
  // eligible so the floor cannot strand consumer-missed rows of below-floor
  // artists once BS#895 turns this cron into the recovery sweep.
  const recencyArm =
    recencyDays > 0
      ? sql`
        OR f."add_time" > now() - (${recencyDays} * interval '1 day')`
      : sql``;

  // Eligibility disjunction (decision 4): linked OR at/above the floor OR
  // recent OR library-by-name. Omitted entirely at playFloor=0 — the floor
  // is disabled and every pending row is eligible. Arm order is deliberate:
  // PG evaluates OR arms left-to-right with short-circuit (the planner's
  // cost reordering applies only to top-level ANDed quals), so the free
  // comparisons run before the correlated EXISTS subplan — most library
  // artists clear the plays arm without ever probing. The EXISTS keys on
  // `p.artist_norm`, which the INNER JOIN already bound to
  // `normalize_artist_name(f."artist_name")` (the function is total, so the
  // join never drops a pending row); re-computing the normalize call inside
  // the EXISTS would evaluate the inlined regexp a second time per probed
  // row — PG does no cross-clause common-subexpression elimination.
  const eligibility =
    playFloor > 0
      ? sql`
      AND (
        f."album_id" IS NOT NULL
        OR p.plays >= ${playFloor}${recencyArm}
        OR EXISTS (
          SELECT 1 FROM library_artists la
          WHERE la.artist_norm = p.artist_norm
        )
      )`
      : sql``;

  // `library_artists` reads `artist_search_alias` SOURCE-BLIND — a
  // deliberate choice, sanctioned by BS#1591 decision 3's literal
  // "OR-extended with `artist_search_alias.variant`". This diverges from
  // jobs/concerts-artist-resolver/query.ts's SYNONYM/RELATIONAL source
  // partition (BS#1383) on purpose: that partition guards FK *writes*
  // (where a relational `discogs_member` alias mislabels data); here it
  // only widens floor *eligibility*, and a row exempted via a member-alias
  // still enriches under its own artist name — no mislabel is possible,
  // and member-of-library-band names are typically cacheable anyway.
  // CHOKEPOINT: if LML ever emits a broader relational source (collaborator
  // / label-roster class), the alias consumer ingests it automatically and
  // this CTE silently widens the exemption — revisit against
  // SYNONYM_ALIAS_SOURCES then.
  const rows = unwrapRows<WorkListRow>(
    await db.execute(sql`
    WITH plays AS (
      SELECT ${NORMALIZE_FN}("artist_name") AS artist_norm, COUNT(*)::int AS plays
      FROM ${FLOWSHEET_TABLE}
      WHERE "entry_type" = 'track' AND "artist_name" IS NOT NULL
      GROUP BY 1
    ),
    library_artists AS (
      SELECT ${NORMALIZE_FN}("artist_name") AS artist_norm FROM ${ARTISTS_TABLE}
      UNION
      SELECT ${NORMALIZE_FN}("variant") FROM ${ARTIST_SEARCH_ALIAS_TABLE}
    )
    SELECT f."id" AS id, p.plays AS plays
    FROM ${FLOWSHEET_TABLE} f
    JOIN plays p ON p.artist_norm = ${NORMALIZE_FN}(f."artist_name")
    WHERE ${pendingPredicate(partitionFilter)}${eligibility}
    ORDER BY p.plays DESC, p.artist_norm ASC, f."id" ASC
  `),
    'work-list select'
  );

  const ids = new Array<number>(rows.length);
  const plays = new Array<number>(rows.length);
  rows.forEach((row, i) => {
    ids[i] = Number(row.id);
    plays[i] = Number(row.plays);
  });

  // Exact complement of the eligibility disjunction within the pending set,
  // computed by subtraction. Clamped: mid-build races (a row hard-deleted,
  // marker-stamped by an out-of-band writer — the CDC worker never writes
  // the marker — or a fresh row aging past the 60s guard, between the two
  // statements) can skew by a few rows, and this field is observability
  // only; the retire-criterion comparison in the docs is approximate.
  const belowFloorSkipped = playFloor === 0 ? 0 : Math.max(0, pendingTotal - ids.length);

  return { ids, plays, pendingTotal, belowFloorSkipped };
};
