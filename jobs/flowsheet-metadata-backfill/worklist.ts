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
 * fragment so they cannot drift. The count runs FIRST so an empty cohort
 * skips the expensive statement entirely; rows stamped or aging past the
 * race guard between the two statements can skew the subtraction by a hair,
 * which is why it is clamped at 0 — the field is observability, not control
 * flow.
 *
 * Cost: the `plays` CTE is a seq scan + regexp + GROUP BY over ~2.9M track
 * rows and the outer join computes `normalize_artist_name` per pending row.
 * Expected tens of seconds; the job container ships
 * `DB_STATEMENT_TIMEOUT_MS=300000` (Dockerfile.flowsheet-metadata-backfill)
 * so the budget is 5 minutes. Memory: two packed number arrays (~14MB at a
 * 900k cohort) steady-state, with a transient postgres-js row-object peak an
 * order of magnitude smaller than the host's headroom.
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
 * Build the run's work-list. Two statements:
 *
 *   1. `COUNT(*)` of the whole pending cohort — served by the partial index
 *      from #659/#660, cheap. A zero count early-exits before the expensive
 *      statement (relevant once BS#895 re-scopes this cron to hourly).
 *   2. The priority SELECT: plays aggregate CTE + library-artists CTE +
 *      pending predicate + eligibility disjunction + priority ORDER BY.
 *
 * The `library_artists` CTE is declared unconditionally but referenced only
 * inside the eligibility clause; when `playFloor` is 0 Postgres never
 * executes the unreferenced CTE, so there is no cost to the simpler
 * single-shape assembly.
 */
export const buildWorkList: BuildWorkListFn = async ({ playFloor, recencyDays, partitionFilter }) => {
  const countRows = (await db.execute(sql`
    SELECT COUNT(*)::int AS pending_total
    FROM ${FLOWSHEET_TABLE} f
    WHERE ${pendingPredicate(partitionFilter)}
  `)) as unknown as Array<{ pending_total: number | string }>;
  const pendingTotal = Number(countRows?.[0]?.pending_total ?? 0);

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

  // Eligibility disjunction (decision 4): linked OR library-by-name OR at/
  // above the floor OR recent. Omitted entirely at playFloor=0 — the floor
  // is disabled and every pending row is eligible.
  const eligibility =
    playFloor > 0
      ? sql`
      AND (
        f."album_id" IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM library_artists la
          WHERE la.artist_norm = ${NORMALIZE_FN}(f."artist_name")
        )
        OR p.plays >= ${playFloor}${recencyArm}
      )`
      : sql``;

  const rows = (await db.execute(sql`
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
  `)) as unknown as WorkListRow[];

  const resultRows = rows ?? [];
  const ids = new Array<number>(resultRows.length);
  const plays = new Array<number>(resultRows.length);
  resultRows.forEach((row, i) => {
    ids[i] = Number(row.id);
    plays[i] = Number(row.plays);
  });

  // Exact complement of the eligibility disjunction within the pending set,
  // computed by subtraction. Clamped: mid-build races (a row stamped by the
  // worker, or a fresh row aging past the 60s guard, between the two
  // statements) can skew by a hair, and this field is observability only.
  const belowFloorSkipped = playFloor === 0 ? 0 : Math.max(0, pendingTotal - ids.length);

  return { ids, plays, pendingTotal, belowFloorSkipped };
};
