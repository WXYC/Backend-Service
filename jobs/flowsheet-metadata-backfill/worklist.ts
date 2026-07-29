/**
 * Play-priority work-list for the flowsheet-metadata-backfill drain (BS#1591),
 * retuned into the Epic C C6 hourly recovery sweep by BS#895.
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
 *     `recencyDays = 0` disables the exemption. In practice, once BS#895's
 *     `recoveryWindowHours` ceiling (below) is active, every candidate row
 *     is already far younger than `recencyDays` (default 30 days vs. a
 *     handful of hours), so this exemption arm is always satisfied and the
 *     play-floor/library-eligibility machinery effectively becomes a no-op
 *     for the live hourly cron — kept intact rather than removed because it
 *     still gates the historical-catch-up shape (`recoveryWindowHours=0`).
 *   - Grace window + recovery-window ceiling (BS#895 / Epic C C6, see
 *     `BuildWorkListArgs`): `graceMinutes` gives the CDC consumer first
 *     crack at a freshly-inserted row before the sweep spends an LML call on
 *     it; `recoveryWindowHours` is a hard age ceiling that keeps the sweep
 *     from re-matching the ~748k-row undrained historical backlog (#1011
 *     retired the daily drain without draining it — see the 2026-07-23
 *     design-constraint comment on #895).
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
 * separate snapshots, so a row hard-deleted, claimed by the live CDC worker
 * (which flips `metadata_status` off `'pending'` — the sole control-flow
 * gate since BS#895), or aging past the grace window in between can skew
 * the subtraction by a few rows. That is why it is clamped at 0 and why the
 * retire-criterion docs call the residual approximate — the field is
 * observability, not control flow.
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
const ROTATION_TABLE = sql.raw(`"${SCHEMA}"."rotation"`);
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
  /**
   * BS#895 (Epic C C6 retune). Consumer grace window in minutes: rows
   * younger than this are never eligible, giving the CDC enrichment
   * worker (`apps/enrichment-worker`) first crack before the recovery
   * sweep spends an LML call on the same row. Replaces the old 60-second
   * race guard (sized only to dodge the — now-removed — runtime
   * fire-and-forget writer) now that this cron's role is "catch what the
   * consumer missed," not "beat a concurrent writer by a few seconds."
   */
  graceMinutes: number;
  /**
   * BS#895 (Epic C C6 retune, 2026-07-23 design constraint). Hard age
   * ceiling in hours: rows older than this are excluded from the pending
   * predicate entirely, regardless of the play-floor/library eligibility
   * arms below. Required because #1011 retired the historical daily drain
   * WITHOUT draining it — ~748k rows sit at `metadata_status='pending'`
   * older than any grace window, and without this ceiling the hourly sweep
   * would match all of them on its first run instead of the "tens of
   * rows/hour" the C6 sizing assumes, false-triggering the "thousands →
   * consumer leak" alarm. `0` disables the ceiling (only sensible for a
   * catch-up/backfill run, never for the live hourly cron).
   */
  recoveryWindowHours: number;
};

export type BuildWorkListFn = (args: BuildWorkListArgs) => Promise<WorkList>;

/**
 * The canonical pending predicate — entry_type/artist_name/lifecycle-status
 * clauses, the consumer grace window, the optional recovery-window ceiling,
 * and the optional PARTITION_INDEX / PARTITION_COUNT fragment. Shared by the
 * count and work-list statements so the subtraction-based below-floor count
 * cannot drift from the selection. Both statements alias flowsheet as `f`;
 * the partition fragment's unqualified `"id"` resolves to `f."id"` (no other
 * relation in scope carries an `id` column).
 *
 * BS#895 (Epic C C6): `metadata_status = 'pending'` replaces the pre-BS#891
 * implicit marker (`metadata_attempt_at IS NULL`) as the control-flow gate —
 * see the module docstring and `docs/migrations.md` "Attempt-at markers".
 * The grace-window clause replaces the old 60-second race guard.
 */
const pendingPredicate = (partitionFilter: SQL | null, graceMinutes: number, recoveryWindowHours: number): SQL => sql`
  f."entry_type" = 'track'
      AND f."artist_name" IS NOT NULL
      AND f."metadata_status" = 'pending'
      AND f."add_time" < now() - (${graceMinutes} * interval '1 minute')
      ${recoveryWindowHours > 0 ? sql`AND f."add_time" > now() - (${recoveryWindowHours} * interval '1 hour')` : sql``}
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
 *   1. `COUNT(*)` of the whole pending cohort — served by the
 *      `flowsheet_metadata_status_pending_idx` partial index, cheap. Under
 *      the pre-BS#895 historical-drain shape (`recoveryWindowHours=0`) the
 *      zero-count early-exit below was a purely defensive guard: with the
 *      play-floor on, the deliberate below-floor residual kept this count
 *      permanently non-zero, so the exit only fired in floor-disabled
 *      fully-drained worlds, fresh environments, and CI. BS#895's
 *      `recoveryWindowHours` ceiling is what turns this into the "cheap
 *      no-op probe" the hourly cron actually needs: it scopes the count down
 *      to a genuinely small, genuinely-reachable-zero window instead of the
 *      unbounded historical cohort.
 *   2. The priority SELECT: plays aggregate CTE + library-artists CTE +
 *      pending predicate + eligibility disjunction + priority ORDER BY.
 *
 * The `library_artists` CTE is declared unconditionally but referenced only
 * inside the eligibility clause; when `playFloor` is 0 Postgres never
 * executes the unreferenced CTE, so there is no cost to the simpler
 * single-shape assembly.
 */
export const buildWorkList: BuildWorkListFn = async ({
  playFloor,
  recencyDays,
  partitionFilter,
  graceMinutes,
  recoveryWindowHours,
}) => {
  const countRows = unwrapRows<{ pending_total: number | string }>(
    await db.execute(sql`
    SELECT COUNT(*)::int AS pending_total
    FROM ${FLOWSHEET_TABLE} f
    WHERE ${pendingPredicate(partitionFilter, graceMinutes, recoveryWindowHours)}
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
    WHERE ${pendingPredicate(partitionFilter, graceMinutes, recoveryWindowHours)}${eligibility}
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
  // claimed by the CDC worker, or a fresh row aging past the grace window,
  // between the two statements) can skew by a few rows, and this field is
  // observability only; the retire-criterion comparison in the docs is
  // approximate.
  const belowFloorSkipped = playFloor === 0 ? 0 : Math.max(0, pendingTotal - ids.length);

  return { ids, plays, pendingTotal, belowFloorSkipped };
};

/**
 * BS#895 / epic #1810 W4 ("make `enriched_no_match` self-heal"). Defensive
 * cap on the self-heal candidate list — this cohort is expected to be a few
 * hundred rows (epic #1810's 2026-07-25 audit: 100 rotation-linked
 * `enriched_no_match` rows already carrying an unused `discogs_release_id`,
 * plus 308 lacking one), so this is a safety ceiling against an unforeseen
 * write-pattern anomaly, not an operational lever. Not env-configurable —
 * unlike the tunables above, there's no legitimate reason to widen it.
 */
export const SELF_HEAL_MAX_CANDIDATES = 2000;

/**
 * W4 self-heal candidate query (epic #1810, folded into BS#895 per the
 * 2026-07-25 scoping comment on this issue). Re-selects rotation-linked
 * flowsheet rows stuck at the terminal `metadata_status = 'enriched_no_match'`
 * once their linked `rotation.discogs_release_id` transitions NULL→present —
 * e.g. after `jobs/rotation-release-id-backfill`'s six-hourly resolver mints
 * an id for a rotation row that was blank when this job (or the CDC worker)
 * last tried it.
 *
 * STATE-CHANGE-GATED, not blind time (the ticket's explicit requirement):
 * a candidate must satisfy
 *
 *   f.metadata_attempt_at IS NULL
 *   OR r.discogs_release_id_resolve_attempted_at > f.metadata_attempt_at
 *
 * — i.e. either this job has never re-attempted the row since it went
 * `enriched_no_match` (the common case: the CDC worker, not this job, wrote
 * the terminal status, so `metadata_attempt_at` is NULL — see
 * `apps/enrichment-worker/enrich.ts`'s "No `metadata_attempt_at` stamping
 * here" contract), or the rotation resolver has stamped a definitive
 * response strictly AFTER this job's last attempt. Once this job re-attempts
 * a row (`applyEnrichment` with `fromStatus: 'enriched_no_match'` — see
 * `enrich.ts` — always stamps `metadata_attempt_at = now()`, win or lose),
 * the row drops out of the candidate set until the rotation id changes
 * again: no TTL, no blind re-scan, no re-burning LML on a row that still
 * won't resolve. Reuses two existing columns rather than adding a new
 * marker — `rotation.discogs_release_id_resolve_attempted_at` (migration
 * 0131, BS#1813) and `flowsheet.metadata_attempt_at` (migration 0069) — so
 * this needed no schema change beyond the `flowsheet_rotation_no_match_idx`
 * partial index (migration 0132) that makes the join cheap.
 *
 * Deliberately does NOT require `r.discogs_release_id_resolve_attempted_at`
 * to be non-NULL: a rotation row can acquire a `discogs_release_id` from a
 * source that never stamps that marker (`tubafrenzy_paste` paste-URL
 * prefill, `library_identity` from `addToRotation` — see
 * `discogsReleaseIdSourceEnum` in schema.ts). Such a row still satisfies the
 * `metadata_attempt_at IS NULL` disjunct on its first encounter (the common
 * worker-authored case) and is picked up the same way.
 *
 * `ORDER BY f.id ASC` is arbitrary-but-deterministic — this cohort has no
 * play-priority story of its own (it piggybacks on the main sweep's
 * per-row LML pacing), so simple insertion order is fine.
 *
 * BS#895 review follow-up (finding #6, decision-only — no behavior change):
 * `r.discogs_release_id IS NOT NULL` is a SELECTION heuristic, not a
 * resolution mechanism. This query does not pass the resolved id to LML —
 * the row is re-enriched via the SAME text-based `lookupMetadata(artist,
 * album, track)` `/lookup` call every other candidate uses (see
 * `orchestrate.ts`'s `selfHealEnrich` default), never LML's
 * `/releases/resolve` by-id endpoint. That's deliberate: epic #1810's W2
 * (#1811, "consume rotation.discogs_release_id via /releases/resolve") was
 * closed as superseded once the 2026-07-25 re-diagnosis identified the
 * actual root cause of blank rotation metadata as a B3 regression (#1815,
 * merged) — the live enrichment path's `/lookup` (single-row, not the
 * `/lookup/bulk` this job avoids) already resolves non-library releases via
 * text search once `allow_release_resolution_fallback` is honored, so no
 * by-id resolver was needed. Resurrecting a by-id path here would re-open
 * that closed decision without a new requirement forcing it — see the
 * #895/#1874 PR discussion for the fuller reasoning.
 *
 * The practical consequence: this heuristic's usefulness depends entirely
 * on `/lookup`'s text search actually finding the now-known-to-exist
 * release, NOT on the id being present. If that coupling ever regresses
 * (e.g. a future change reintroduces a bulk-style kill switch on this
 * job's `/lookup` calls, or LML's text search degrades), the SELECTION
 * would still fire — `self_heal_candidates` stays healthy — but the
 * RESOLUTION would silently stop working. `self_heal_candidates` vs
 * `self_heal_resolved` (`Totals`, `orchestrate.ts`) is the pair to watch:
 * a sustained gap between them (candidates found every run, resolved
 * staying near zero) is the signal that this coupling has broken, not a
 * sign that the candidates themselves are wrong.
 */
export const buildRotationSelfHealCandidates = async (): Promise<number[]> => {
  const rows = unwrapRows<{ id: number | string }>(
    await db.execute(sql`
    SELECT f."id" AS id
    FROM ${FLOWSHEET_TABLE} f
    JOIN ${ROTATION_TABLE} r ON r."id" = f."rotation_id"
    WHERE f."metadata_status" = 'enriched_no_match'
      AND f."rotation_id" IS NOT NULL
      AND r."discogs_release_id" IS NOT NULL
      AND (
        f."metadata_attempt_at" IS NULL
        OR r."discogs_release_id_resolve_attempted_at" > f."metadata_attempt_at"
      )
    ORDER BY f."id" ASC
    LIMIT ${SELF_HEAL_MAX_CANDIDATES}
  `),
    'rotation self-heal candidates'
  );
  return rows.map((row) => Number(row.id));
};

export type BuildSelfHealCandidatesFn = typeof buildRotationSelfHealCandidates;

/**
 * BS#895 review follow-up (finding #3 of the code-review pass): the
 * `recoveryWindowHours` ceiling is load-bearing (it's what keeps the hourly
 * sweep from re-matching the ~748k-row undrained historical `pending`
 * backlog #1011 left behind — see `pendingPredicate` above), but it means
 * any genuine consumer-miss OLDER than the window is silently excluded from
 * every future sweep forever, with no automated path back to `'pending'`
 * eligibility. This turns that silent exclusion into an observable count:
 * rows that are still `metadata_status = 'pending'` (never enriched) AND
 * older than the ceiling — i.e. exactly the complement the ceiling carves
 * off `pendingPredicate`'s cohort.
 *
 * Reuses the SAME `flowsheet_metadata_status_pending_idx` partial index the
 * main pending-count already scans (same cost profile as that existing
 * query — see worklist.ts's module docstring on the `plays` CTE / count
 * cost — not a new index, not a new scan shape). Gated on
 * `recoveryWindowHours > 0`: with the ceiling disabled (historical
 * catch-up shape) nothing is excluded by age, so "stranded past the
 * ceiling" isn't a meaningful concept and the query is skipped entirely
 * (returns 0, zero extra cost).
 *
 * Trend ("growing") detection is deliberately NOT computed here — this
 * job is a stateless cron run with no persisted cross-run memory, so
 * "is this count bigger than last run's" isn't something a single
 * invocation can answer on its own. The count is projected as a numeric
 * Sentry span attribute (`backfill.stranded_past_recovery_window`, see
 * `runBackfill`) specifically so the trend can be read off Sentry's own
 * time-series / anomaly-detection alerting on that attribute — the same
 * pattern the org uses for CloudWatch metrics (see `wxyc-canary`'s
 * `ANOMALY_DETECTION_BAND` convention referenced in the org CLAUDE.md) —
 * rather than reinventing trend-tracking state inside the job.
 */
export const countStrandedPastRecoveryWindow = async (recoveryWindowHours: number): Promise<number> => {
  if (recoveryWindowHours <= 0) return 0;

  const rows = unwrapRows<{ stranded_total: number | string }>(
    await db.execute(sql`
    SELECT COUNT(*)::int AS stranded_total
    FROM ${FLOWSHEET_TABLE} f
    WHERE f."entry_type" = 'track'
      AND f."artist_name" IS NOT NULL
      AND f."metadata_status" = 'pending'
      AND f."add_time" <= now() - (${recoveryWindowHours} * interval '1 hour')
  `),
    'stranded past recovery window count'
  );
  if (rows.length !== 1) {
    throw new Error(
      `flowsheet-metadata-backfill: stranded-past-recovery-window count returned ${rows.length} rows; expected 1`
    );
  }
  const strandedTotal = Number(rows[0].stranded_total);
  if (!Number.isFinite(strandedTotal)) {
    throw new Error(
      `flowsheet-metadata-backfill: stranded-past-recovery-window count returned non-numeric ${JSON.stringify(rows[0])}`
    );
  }
  return strandedTotal;
};
