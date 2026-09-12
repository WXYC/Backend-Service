/**
 * Legacy linkage resolve: link `flowsheet` / `rotation` rows to their library
 * album once the library row exists.
 *
 * Both writer paths resolve `album_id` exactly once, at write time, against
 * whatever `library` held at that instant:
 *
 *   - `/internal/flowsheet-webhook` resolves on INSERT and deliberately never
 *     refreshes on conflict — "linkage is anchored to the first delivery"
 *     (apps/backend/routes/internal.route.ts).
 *   - `/internal/rotation-webhook` resolves once via `resolveAlbumId(rawLibraryId)`.
 *
 * That is a race against `jobs/library-etl/`, which imports the catalog on its
 * own half-hourly schedule, and against the librarian, who routinely files the
 * physical release *after* the MD bins it. Any row whose library row lands
 * second keeps `album_id = NULL` forever unless something re-runs the join.
 *
 * Until Phase 3 of the tubafrenzy decommission that "something" was a tail
 * pass inside `jobs/flowsheet-etl/` and `jobs/rotation-etl/`, which ran every
 * 30 minutes. Those jobs were unscheduled when Backend became canonical
 * (WXYC/wiki#88) because their *import* half now writes backwards — from
 * tubafrenzy's mirror copy onto Backend-canonical rows. Their repair half has
 * no such problem: it reads and writes only Backend's own tables and never
 * contacts tubafrenzy. This job is that repair half, lifted out verbatim so it
 * survives the import's retirement.
 *
 * Both statements are anti-joined on `album_id IS NULL`, so a run with nothing
 * to fix is a no-op and re-running is idempotent.
 *
 * CONTENTION (BS#2413). "No-op" became a claim about rows, not about locks,
 * when BS#2071 replaced each pass's `candidates === 0` early return with an
 * unconditional data-modifying CTE: the rotation UPDATE fires a `FOR EACH
 * STATEMENT` trigger that rewrites the single-row `library_watermark` table
 * even on `UPDATE 0`, so every run — including the ~98% with nothing to
 * repair — queued behind what was then `jobs/library-etl`'s single 13-15
 * minute import transaction and died at the 300 s `statement_timeout`. Two
 * levers restore it, and `LINKAGE_LOCK_TIMEOUT_MS`'s docblock has the full
 * mechanism: a candidate pre-check, so a pass with nothing to do issues no
 * UPDATE at all; and `SET LOCAL lock_timeout` inside an explicit transaction,
 * so a pass that does have work stands down in under a second with a
 * lock-specific SQLSTATE instead of burning five minutes and reporting a
 * generic failed query. The root-cause fix was BS#2424, and it has landed:
 * `library-etl` now runs two transactions rather than one, and its
 * compilation-track writes are batched, so the common case holds the
 * watermark row for seconds. These levers stay because the window narrowed
 * rather than closed — the once-daily full secondary reconciliation pass
 * still runs the cross-reference imports unbounded inside one transaction.
 * See the README's "Contention" section.
 *
 * No cooperative live-DJ pause:
 * the candidate set is bounded by the rows a webhook could not link, the writes
 * are narrow, and deferring the repair indefinitely during a long show is worse
 * than the contention it would avoid.
 *
 * LIVENESS (BS#2064). Because a healthy idle run writes nothing and logs
 * `candidates: 0`, a cron that stopped running used to be byte-identical to one
 * that ran and found nothing. Three signals now distinguish them; see
 * `docs/ops-cron-scheduling.md` ("Cron liveness") for the fleet-general recipe.
 *
 *   (a) A Sentry cron monitor check-in (`Sentry.withMonitor`) around the real
 *       run. Sentry raises a *missed check-in* when a run does not happen —
 *       precisely the failure mode a try/catch cannot see (crontab entry
 *       dropped, image pull denied, docker wedged, host rebooted).
 *   (b) A `cronjob_runs` heartbeat row written after a successful run.
 *   (c) A drain check: the cohort count and the UPDATE are measured inside one
 *       data-modifying CTE, so both numbers come from the same snapshot
 *       (BS#2071: two separate `db.execute` calls, whether
 *       pre-UPDATE-vs-resolved or resolved-vs-post-UPDATE-recount, straddled
 *       two snapshots and both directions of that gap were a benign
 *       concurrent write somewhere else — `library-etl` runs on this job's
 *       own half-hourly slot. One statement means one snapshot, which closes
 *       that gap). A nonzero residual is evidence worth a warning, not proof
 *       of a stuck UPDATE: one snapshot guarantees `candidates` and
 *       `resolved` are read together, not that no other session can touch a
 *       cohort row while the statement runs — a concurrent UPDATE or DELETE
 *       on a row already in `cohort` can still make it drop out of `upd` via
 *       Postgres's EvalPlanQual re-check (see `hasUnresolvedResidue`'s
 *       docblock for the mechanics).
 *
 * Usage:
 *   node dist/job.js              # resolve (default)
 *   node dist/job.js --dry-run    # report candidate counts, write nothing
 */

import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import {
  db,
  flowsheet,
  rotation,
  library,
  closeDatabaseConnection,
  getLastRunTimestamp,
  updateLastRun,
  requirePositiveInt,
} from '@wxyc/database';
import { initLogger, log, captureError, captureWarning, errorMessage, closeLogger } from './logger.js';

export const JOB_NAME = 'legacy-linkage-resolve';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');

/**
 * Bounds how long either pass waits for the locks its UPDATE needs (BS#2413).
 *
 * **What it is actually waiting for.** `library-etl` never writes `rotation`
 * or `flowsheet`, so the contention is not on this job's own target rows. It
 * is on `wxyc_schema.library_watermark`, a SINGLE-row table
 * (`CONSTRAINT library_watermark_singleton CHECK ("id" = true)`, migration
 * 0104) that nine `FOR EACH STATEMENT` triggers all rewrite —
 * `touch_library_watermark` on `library`, and, among the parent-table fan-out
 * in migration 0105, `touch_library_watermark_from_rotation`. Every statement
 * that fires one takes an exclusive row lock on that one row and holds it
 * until COMMIT. When this was diagnosed, `jobs/library-etl` wrapped its whole
 * run in a single transaction, grabbed the row on its first `library` write,
 * and held it for the 13-15 minutes the import took; this job's rotation
 * UPDATE fired the rotation trigger, asked for the same row, and was
 * cancelled at the image's 300 s `DB_STATEMENT_TIMEOUT_MS` long before
 * `library-etl` committed.
 *
 * BS#2424 has since split that import into two transactions and batched its
 * compilation-track writes, so an ordinary pass holds the row for seconds.
 * The residual is the once-daily full secondary reconciliation pass
 * (`SECONDARY_FULL_PASS_INTERVAL_HOURS`), which drops the delta bounds and
 * re-runs the row-at-a-time `artist_crossreference` import, whose own
 * migration-0138 trigger reuses `touch_library_watermark()` against the same
 * single row, inside one transaction. Rarer, not gone.
 *
 * A statement-level trigger fires on `UPDATE 0` as well, so on the rotation
 * pass an empty cohort is NOT protection: the ~98% of runs that find nothing
 * still asked for that row, and still waited out the full 300 s for it. That
 * is what the candidate pre-check below is for — a separate lever from this
 * timeout, not a redundant one.
 *
 * **The two passes are exposed differently, and both are guarded anyway.**
 * `flowsheet` carries no `library_watermark` trigger — migrations
 * 0104/0105/0138/0142/0143/0159 attach those to `library`, `artists`,
 * `genres`, `format`, `genre_artist_crossreference`, `rotation`,
 * `artist_crossreference`, `compilation_track_artist` and `digital_asset`, and
 * none of them to `flowsheet`. That is what makes `library-etl` specifically a
 * rotation-pass problem.
 *
 * It does NOT make the flowsheet pass lock-free. `flowsheet` carries its own
 * `touch_flowsheet_watermark` (migration 0084) — also `FOR EACH STATEMENT`,
 * also over a singleton (`flowsheet_watermark_singleton CHECK ("id" = true)`),
 * also fired on `UPDATE 0` — so the flowsheet drain contends for THAT row with
 * every `flowsheet` writer (a live DJ's play insert, `flowsheet-metadata-
 * backfill` on its `10 * * * *` slot) and with `concerts` writers, which fire
 * the same function via migration 0114. Plus the narrower
 * `flowsheet.album_id -> library.id` FK check, which takes `FOR KEY SHARE` on
 * each `library` row it actually links and so can queue behind a `FOR UPDATE`
 * `library-etl` holds on that row.
 *
 * The practical consequence is the same for both passes and is why the
 * pre-check gate is applied to both: an empty cohort is safe because this job
 * then issues no UPDATE at all, NOT because the flowsheet table has nothing to
 * fire. Do not "simplify" the flowsheet pass by dropping its pre-check on the
 * reasoning that it has no trigger to fire — it does.
 *
 * **Why below 1 s.** Deliberately under Postgres's default 1 s
 * `deadlock_timeout`, the same reasoning (and the same value) as
 * `DELETE_ALBUM_LOCK_TIMEOUT_MS` in `apps/backend/services/library.service.ts`,
 * and here it closes a real cycle rather than a hypothetical one: this job
 * holds `FOR KEY SHARE` on `library` rows (the `album_id` FK check) and wants
 * the watermark row, while `library-etl` holds the watermark row and wants
 * `FOR UPDATE` on `library` rows. Giving up before the deadlock detector runs
 * makes this job always the side that stands down, so it can never be the
 * reason a quarter-hour import transaction is aborted as the chosen victim.
 *
 * 750 ms is also ~2 orders of magnitude above a live UI write's hold on the
 * same row (`POST`/`PATCH /library` fire the same trigger and commit in
 * milliseconds), so a normal librarian edit does not trip it.
 */
export const LINKAGE_LOCK_TIMEOUT_MS = 750;

/**
 * Postgres SQLSTATEs this job converts into a clean stand-down rather than a
 * failed run. Same pair as `library.service.ts`'s `LOCK_CONTENTION_SQLSTATES`.
 *
 * Deliberately does NOT include `57014` (`query_canceled`, which is what the
 * 300 s `statement_timeout` raises). If the guard ever fails to bind — a
 * `SET LOCAL` issued outside an explicit transaction is silently
 * connection-scoped-and-discarded under the postgres-js driver — `57014` is
 * the error that comes back, and it must stay a hard failure rather than be
 * reported as a deliberate skip.
 */
const LOCK_CONTENTION_SQLSTATES = new Set([
  '55P03', // lock_not_available — our own lock_timeout fired
  '40P01', // deadlock_detected — we were chosen as the victim
]);

/**
 * The SQLSTATE is NOT at the top level of what `tx.execute` throws.
 * drizzle-orm (0.45.x) wraps every query rejection in a `DrizzleQueryError`
 * whose `message` is the generic `Failed query: …` and whose `.cause` is the
 * postgres-js `PostgresError` carrying `.code` (`drizzle-orm/errors.js`; the
 * wrap is unconditional, in `pg-core/session.js`'s `queryWithCache`). Reading
 * only `error.code` therefore sees `undefined` for a real `55P03`, the guard
 * never converts the block into a stand-down, and the run fails with the
 * generic message this change exists to stop reporting — while every unit
 * test that throws a hand-built `{ code }` still passes, because a mock
 * cannot reproduce the wrapper.
 *
 * So: prefer `cause.code`, fall back to a top-level `.code`. Same shape as
 * `extractSqlState` in `jobs/flowsheet-metadata-backfill/orchestrate.ts`,
 * `classifyDatabaseError` in `apps/backend/services/health/database-check.ts`,
 * and the `23503` check in `apps/backend/routes/internal-bans.route.ts` — the
 * fallback is what keeps a bare driver error (and the test doubles that model
 * one) classifying correctly alongside the wrapped production form.
 */
const isLockContentionError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
  const code = causeCode ?? (error as { code?: unknown }).code;
  return typeof code === 'string' && LOCK_CONTENTION_SQLSTATES.has(code);
};

/**
 * Must stay byte-identical to `package.json`'s `cron-schedule`, which is what
 * `deploy-base.yml` installs in the EC2 crontab. Sentry upserts the monitor
 * from this value on the first check-in, so a drift here would make the monitor
 * expect a cadence the host does not run — pinned by a unit test rather than
 * read from `package.json`, which tsup does not bundle into `dist/`.
 */
export const CRON_SCHEDULE = '*/30 * * * *';

/**
 * Minutes past the scheduled slot before Sentry counts a check-in as missed.
 * Sentry's clock starts at the missed slot itself — expected time plus
 * `checkinMargin` — so 10 here flags a skipped run ~10 min after the slot it
 * skipped, not ~40. The 40-minute figure is real, but it's the gap since the
 * *last successful* run (one full 30-minute cadence, plus this 10-minute
 * margin) — a different reference point that makes detection look four times
 * slower than it is. 10 min also absorbs a deploy that recreates the crontab
 * entry a few minutes late.
 */
export const CHECKIN_MARGIN_MINUTES = 10;

/**
 * Minutes a run may stay `in_progress` before Sentry marks it timed out.
 * Under the 30-minute cadence so a wedged run is flagged before the next one
 * fires. Not derived by summing per-statement timeouts, and the arithmetic
 * would not close if it were: the monitored callback issues up to nine
 * statements in the current worst case (per pass, a candidate COUNT pre-check,
 * a `SET LOCAL lock_timeout`, one combined cohort-count-and-UPDATE CTE —
 * BS#2071 folded the COUNT and the UPDATE into a single statement so they
 * share one snapshot — and a conditional ANALYZE, plus the heartbeat upsert),
 * against a pool whose image sets `DB_STATEMENT_TIMEOUT_MS=300000` (5 min
 * each). That product has been past 25 minutes since BS#2071 and is further
 * past it now. The real ceiling is the deploy:
 * `deploy-base.yml`'s cron install runs `docker rm -f <target>-cron` ahead of
 * every `docker run`, so the next half-hourly slot SIGKILLs any run still
 * alive from the previous one. No run can legitimately outlive the cadence,
 * so 25 under 30 is the right number regardless of what the statements
 * inside it add up to — and a SIGKILLed run sends no terminal check-in and
 * writes no heartbeat, exactly the "the run did not happen" shape signals
 * (a) and (b) exist to report.
 */
export const MAX_RUNTIME_MINUTES = 25;

type MonitorConfig = NonNullable<Parameters<typeof Sentry.withMonitor>[2]>;

export const MONITOR_CONFIG: MonitorConfig = {
  schedule: { type: 'crontab', value: CRON_SCHEDULE },
  checkinMargin: CHECKIN_MARGIN_MINUTES,
  maxRuntime: MAX_RUNTIME_MINUTES,
  // The crontab on the EC2 host runs in UTC; `deploy-base.yml` installs the
  // `cron-schedule` string verbatim without a TZ line.
  timezone: 'Etc/UTC',
};

/**
 * Hours between two successful runs before the gap is worth a warning. The
 * cadence is 30 minutes, so 4 h is eight consecutive missed runs — far past any
 * deploy, reboot, or maintenance window, and deliberately much looser than (a)'s
 * detection window (~10 min after the missed slot; ~40 min after the last
 * successful run) so the two signals do not double-report the same blip.
 *
 * This is a *backstop* to the Sentry monitor, not a replacement: it can only
 * fire once the job runs again, whereas a missed check-in fires while the job
 * is still down.
 */
export const MAX_RUN_GAP_HOURS_DEFAULT = 4;

export const resolveMaxRunGapHours = (raw: string | undefined = process.env.LINKAGE_RESOLVE_MAX_GAP_HOURS): number =>
  requirePositiveInt(raw, 'LINKAGE_RESOLVE_MAX_GAP_HOURS', MAX_RUN_GAP_HOURS_DEFAULT, { unit: 'hours' });

/**
 * `residual` is `null` whenever the pass did not reach its UPDATE — on a dry
 * run, and (BS#2413) on a pass that stood down on lock contention. There is
 * no drain measurement to report in either case, and `0` would be misread as
 * "cohort is clear" rather than "not measured." Only a real (non-dry) pass
 * that actually ran its UPDATE produces a numeric residual.
 *
 * `deferred` marks the stand-down specifically. `candidates` on a deferred
 * pass is what the pre-check COUNT saw — the reason the pass tried at all —
 * and is reported so an operator knows how much repair was skipped; it is
 * never compared against `resolved`, which is what `residual: null` encodes.
 */
export type PassResult = { candidates: number; resolved: number; residual: number | null; deferred: boolean };
export type RunResult = { flowsheet: PassResult; rotation: PassResult };

/**
 * Runs one pass's data-modifying CTE inside an explicit transaction that
 * bounds every lock wait first (BS#2413).
 *
 * Returns `null` — never throws — when the statement is rejected for lock
 * contention, which is the caller's signal to record a stand-down rather than
 * a result. Any other error propagates unchanged.
 *
 * The transaction is not here for isolation: READ COMMITTED gives each
 * statement its own snapshot either way, and BS#2071's whole point is that
 * one statement already carries one snapshot. It is here because `SET LOCAL`
 * only scopes to an explicit transaction under the postgres-js driver (see
 * `shared/database/src/freetext-enumerate.ts`, and the same note on
 * `deleteAlbumFromDB`) — issued on a bare `db.execute` it would be applied to
 * a pooled connection and discarded, leaving the CTE unguarded while looking
 * guarded.
 */
const runGuardedDrain = async (
  statement: Parameters<typeof db.execute>[0]
): Promise<{ candidates: number; resolved: number } | null> => {
  try {
    const rows = (await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${LINKAGE_LOCK_TIMEOUT_MS}ms'`));
      return await tx.execute(statement);
    })) as unknown as Array<{ candidates: number | string; resolved: number | string }>;

    const row = rows?.[0];
    return { candidates: Number(row?.candidates ?? 0), resolved: Number(row?.resolved ?? 0) };
  } catch (error) {
    if (isLockContentionError(error)) return null;
    throw error;
  }
};

/**
 * The flowsheet candidate COUNT, standalone. Two callers, one statement:
 * `--dry-run` reporting, which must count without writing, and (BS#2413) the
 * real pass's pre-check gate.
 *
 * **The pre-check is a gate, not a measurement.** Its number decides only
 * whether to issue the UPDATE at all and is then discarded; `candidates` and
 * `resolved` still both come from the CTE's single snapshot, so the
 * two-snapshot false positive BS#2071 removed is not reintroduced. A row
 * entering or leaving the cohort between this COUNT and the CTE changes
 * nothing an operator sees: the CTE re-measures its own cohort from scratch.
 * The only outcome this COUNT can get "wrong" is skipping a pass whose cohort
 * became non-empty microseconds later, which is indistinguishable from the
 * row landing microseconds after the CTE committed — a next-slot pickup
 * either way, and the cohort has no time bound to strand it.
 *
 * A plain `SELECT` fires no statement trigger and takes no row lock, so this
 * is the one shape that cannot queue behind `library-etl`'s transaction.
 */
const countUnresolvedFlowsheetCandidates = async (): Promise<number> => {
  const [row] = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM ${flowsheet} f
    JOIN ${library} l ON f.legacy_release_id = l.legacy_release_id
    WHERE f.legacy_release_id IS NOT NULL
      AND f.album_id IS NULL
  `)) as unknown as Array<{ count: number | string }>;
  return Number(row?.count ?? 0);
};

/**
 * Link `flowsheet.album_id` by joining `legacy_release_id` to
 * `library.legacy_release_id`. Lifted verbatim from `jobs/flowsheet-etl/`'s
 * `resolveAlbumIds`, then reshaped by BS#2071 (see below).
 *
 * `updated_at` is deliberately not set — migration 0084's trigger owns that
 * column on `flowsheet`.
 *
 * NEVER add a time bound to the `cohort` CTE below (or the rotation one
 * further down). The `cronjob_runs` row BS#2064 introduced is a liveness
 * **heartbeat**, not a delta watermark: filtering the cohort on `last_run`
 * would permanently strand every row whose `library` row landed during a
 * window the job missed, which is the exact bug this job exists to prevent.
 * The cohort is defined by `album_id IS NULL` and nothing else.
 *
 * `cohort` selects `DISTINCT f.id`. Under today's unique index on
 * `library.legacy_release_id` the join can't fan out — each `f.id` matches
 * at most one `l` row — so `DISTINCT` changes nothing right now and the
 * `candidates` count would be exactly the same without it. It is cheap
 * insurance, not a correctness fix for the current schema: if that index
 * were ever dropped (accidentally, or by a future migration that doesn't
 * know this job depends on it), a plain `SELECT f.id` would count one row
 * per matching `library` join partner instead of one per flowsheet row,
 * inflating `candidates` above the true cohort size and tripping the drain
 * check's warning on every run from then on — every 30 minutes, forever,
 * on a job that isn't actually broken. `DISTINCT` costs nothing measurable
 * against this job's small unresolved-row cohort and removes that failure
 * mode outright, so it stays even though the index makes it redundant today.
 *
 * BS#2071: `candidates` and `resolved` used to come from two separate
 * `db.execute` calls (a COUNT, then an UPDATE, optionally followed by a
 * second COUNT) with no wrapping transaction, so each pair straddled its own
 * snapshot boundary and a concurrent write landing in that gap — most often
 * `library-etl`, which shares this job's exact half-hourly cron slot — read as
 * either a false `resolved < candidates` or a false `resolved > candidates`
 * depending on which pair you compared. A single data-modifying CTE measures
 * both numbers from one snapshot: `cohort` is the candidate set, `upd` is the
 * UPDATE restricted to exactly `cohort`'s rows (note the `f.album_id IS NULL`
 * conjunct inside `upd` — see the note below), and the trailing SELECT counts
 * each. This closes the two-snapshot gap the old shape had, but it does not
 * make `resolved === candidates` guaranteed: a row already inside `cohort`
 * can still be concurrently UPDATEd or DELETEd while this statement is
 * running, and Postgres's own concurrency control (EvalPlanQual, under
 * READ COMMITTED) re-checks `upd`'s WHERE clause against that row's
 * just-committed new version — which can legitimately no longer match. A
 * shortfall (`resolved < candidates`) is real evidence to surface, not proof
 * of a stuck UPDATE; see `hasUnresolvedResidue`'s docblock below for what
 * this statement's single snapshot does and does not guarantee. One
 * statement also means one round trip where the old shape needed two (or
 * three): this is a net reduction in per-pass statement count, not the
 * increase the post-write re-COUNT shape briefly was.
 *
 * `upd`'s `f.album_id IS NULL` conjunct (mirrored in the rotation pass as
 * `r.album_id IS NULL`) is load-bearing, not redundant with `cohort`'s
 * identical filter. Under READ COMMITTED, if another session updates a
 * `cohort` row and commits while this UPDATE is waiting on that row's lock,
 * EvalPlanQual re-evaluates the UPDATE's *own* WHERE clause against the new
 * row version before writing it. Without this conjunct, the re-checked qual
 * (`f.id = c.id AND f.legacy_release_id = l.legacy_release_id`) still
 * matches regardless of what the concurrent writer just set `album_id` to —
 * so this job silently overwrites it. `updateEntry`
 * (`apps/backend/services/flowsheet.service.ts`) writes `album_id` without
 * touching `legacy_release_id` — an MD picking an album for a flowsheet
 * entry mid-run is exactly this shape. With the conjunct present, the
 * re-checked qual fails once `album_id` is no longer NULL, so the row drops
 * out of `upd` (not out of `cohort`, which was already fixed by the earlier
 * snapshot) and the concurrent writer's value survives untouched.
 *
 * A plain `BEGIN … COMMIT` around separate COUNT/UPDATE statements does NOT
 * fix this. Postgres defaults to READ COMMITTED, where each statement inside
 * a transaction takes its own fresh snapshot — the race survives a
 * transaction wrapper unchanged. `REPEATABLE READ` would pin one snapshot for
 * the whole transaction, but then risks the UPDATE failing with a
 * serialization error under concurrent writers, which is a worse failure mode
 * than the one being fixed. A single statement is the only shape where "one
 * snapshot" is guaranteed without opting into that risk.
 */
const resolveFlowsheetAlbumIds = async (dryRun: boolean): Promise<PassResult> => {
  const seen = await countUnresolvedFlowsheetCandidates();

  if (dryRun) {
    // residual: null, not 0 — a dry run never reaches the UPDATE, so there is
    // nothing to report a drain measurement for (see PassResult's docblock).
    return { candidates: seen, resolved: 0, residual: null, deferred: false };
  }

  // BS#2413: nothing to repair, so issue no UPDATE — and therefore fire no
  // statement trigger and ask for no lock on the `library_watermark`
  // singleton. This is the shape BS#2071 replaced with an unconditional CTE;
  // it is restored here as an early return, NOT as a count fed into the drain
  // check, which is what made the old shape a two-snapshot comparison.
  if (seen === 0) return { candidates: 0, resolved: 0, residual: 0, deferred: false };

  const measured = await runGuardedDrain(sql`
    WITH cohort AS (
      SELECT DISTINCT f.id
      FROM ${flowsheet} f
      JOIN ${library} l ON f.legacy_release_id = l.legacy_release_id
      WHERE f.legacy_release_id IS NOT NULL
        AND f.album_id IS NULL
    ),
    upd AS (
      UPDATE ${flowsheet} f
      SET album_id = l.id
      FROM ${library} l, cohort c
      WHERE f.id = c.id
        AND f.legacy_release_id = l.legacy_release_id
        AND f.album_id IS NULL
      RETURNING 1
    )
    SELECT
      (SELECT COUNT(*)::int FROM cohort) AS candidates,
      (SELECT COUNT(*)::int FROM upd) AS resolved
  `);

  if (measured === null) {
    return { candidates: seen, resolved: 0, residual: null, deferred: true };
  }

  const { candidates, resolved } = measured;

  // Outside the guarded transaction on purpose, and deliberately not bounded
  // by it: ANALYZE takes ShareUpdateExclusiveLock on the table, which
  // conflicts only with DDL, VACUUM and another ANALYZE — never with the row
  // locks `library-etl` holds, and `library-etl` touches neither `flowsheet`
  // nor `rotation` at all. Keeping it out of the transaction also means the
  // repair's own locks are released before the stats refresh starts.
  if (resolved > 0) {
    await db.execute(sql.raw(`ANALYZE "${SCHEMA}"."flowsheet"`));
  }

  return { candidates, resolved, residual: Math.max(candidates - resolved, 0), deferred: false };
};

/**
 * The rotation candidate COUNT, standalone — same two callers, and the same
 * gate-not-measurement argument, as `countUnresolvedFlowsheetCandidates`
 * above: `--dry-run` reporting, and (BS#2413) the real pass's pre-check gate.
 */
const countUnresolvedRotationCandidates = async (): Promise<number> => {
  const [row] = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM ${rotation} r
    JOIN ${library} l ON r.legacy_library_release_id = l.legacy_release_id
    WHERE r.legacy_library_release_id IS NOT NULL
      AND r.album_id IS NULL
  `)) as unknown as Array<{ count: number | string }>;
  return Number(row?.count ?? 0);
};

/**
 * Link `rotation.album_id` by joining `legacy_library_release_id` to
 * `library.legacy_release_id`, clearing the denormalized display columns the
 * row carried while it was unlinked. Lifted verbatim from
 * `jobs/rotation-etl/`'s `resolveAlbumIds`, then reshaped by BS#2071.
 *
 * Same no-time-bound rule, same single-snapshot CTE shape, and the same
 * `BEGIN … COMMIT` trap as the flowsheet pass above — see that docblock.
 */
const resolveRotationAlbumIds = async (dryRun: boolean): Promise<PassResult> => {
  const seen = await countUnresolvedRotationCandidates();

  if (dryRun) {
    // residual: null, not 0 — a dry run never reaches the UPDATE, so there is
    // nothing to report a drain measurement for (see PassResult's docblock).
    return { candidates: seen, resolved: 0, residual: null, deferred: false };
  }

  // BS#2413 — see the flowsheet pass for why this early return is a gate and
  // not a revival of the BS#2071 two-snapshot comparison.
  if (seen === 0) return { candidates: 0, resolved: 0, residual: 0, deferred: false };

  const measured = await runGuardedDrain(sql`
    WITH cohort AS (
      SELECT DISTINCT r.id
      FROM ${rotation} r
      JOIN ${library} l ON r.legacy_library_release_id = l.legacy_release_id
      WHERE r.legacy_library_release_id IS NOT NULL
        AND r.album_id IS NULL
    ),
    upd AS (
      UPDATE ${rotation} r
      SET album_id = l.id,
          artist_name = NULL,
          album_title = NULL,
          record_label = NULL
      FROM ${library} l, cohort c
      WHERE r.id = c.id
        AND r.legacy_library_release_id = l.legacy_release_id
        AND r.album_id IS NULL
      RETURNING 1
    )
    SELECT
      (SELECT COUNT(*)::int FROM cohort) AS candidates,
      (SELECT COUNT(*)::int FROM upd) AS resolved
  `);

  if (measured === null) {
    return { candidates: seen, resolved: 0, residual: null, deferred: true };
  }

  const { candidates, resolved } = measured;

  // Outside the guarded transaction — see the flowsheet pass's note.
  if (resolved > 0) {
    await db.execute(sql.raw(`ANALYZE "${SCHEMA}"."rotation"`));
  }

  return { candidates, resolved, residual: Math.max(candidates - resolved, 0), deferred: false };
};

export const runResolve = async (dryRun: boolean): Promise<RunResult> => {
  const flowsheetResult = await resolveFlowsheetAlbumIds(dryRun);
  log('info', 'resolve-flowsheet', 'Flowsheet linkage pass complete.', {
    dry_run: dryRun,
    candidates: flowsheetResult.candidates,
    resolved: flowsheetResult.resolved,
    // A dry run never reaches the UPDATE, so `resolveFlowsheetAlbumIds`
    // already returns `residual: null` rather than a `0` an operator could
    // misread as "cohort is clear" — logged straight through, not
    // re-derived here. A deferred pass reports `null` for the same reason.
    residual: flowsheetResult.residual,
    deferred: flowsheetResult.deferred,
  });

  const rotationResult = await resolveRotationAlbumIds(dryRun);
  log('info', 'resolve-rotation', 'Rotation linkage pass complete.', {
    dry_run: dryRun,
    candidates: rotationResult.candidates,
    resolved: rotationResult.resolved,
    residual: rotationResult.residual,
    deferred: rotationResult.deferred,
  });

  return { flowsheet: flowsheetResult, rotation: rotationResult };
};

// ---- Liveness (BS#2064) ----

/** Elapsed hours (fractional) between the last successful run and this one. */
export const gapHours = (lastRunMs: number, startedAtMs: number): number =>
  (startedAtMs - lastRunMs) / (60 * 60 * 1000);

/**
 * A pass whose `resolved` count fell short of its `candidates` count. Signal
 * (c): the job ran, checked in green, and — per this check — did not repair
 * everything it found.
 *
 * BS#2071, first pass: this used to compare a pre-UPDATE `candidates` COUNT
 * against `resolved` and treat `resolved < candidates` as impossible to hit
 * benignly, reasoning that `library.legacy_release_id`'s unique index makes
 * the COUNT and the UPDATE agree. That reasoning only holds under a single
 * snapshot — the COUNT and the UPDATE were two separate `db.execute` calls
 * with no wrapping transaction, so anything that removed a row from the
 * cohort between them (a concurrent `broken-fk-recovery` one-shot run, or a
 * hand-run `flowsheet-etl`/`rotation-etl` repair pass — Phase 3 unscheduled
 * their crontab entries but left `resolveAlbumIds` invocable for Phase 6a
 * ONLY behind `LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1`, so the set of things
 * that can issue this semantically identical UPDATE concurrently is three,
 * not one, but two of those three need that env var deliberately set —
 * issuing it, a DJ deleting the flowsheet entry, an MD editing it and
 * picking an album, an MD deleting the `library` row a candidate joins to)
 * read as `resolved < candidates`: a warning asserting the job "did not
 * repair what it found," on a run where everything worked.
 *
 * BS#2071's first commit tried to close that by re-running the same COUNT
 * *after* the UPDATE and comparing `resolved` against that post-write
 * recount instead. That traded one false positive for a more common one: the
 * pre-UPDATE COUNT and the post-write recount are still two separate
 * `db.execute` calls, still two snapshots, and a `library` row landing in
 * *that* gap — again most plausibly `library-etl`, which runs on this job's
 * own exact half-hourly cron slot, not a rare event — now shows up in the recount as
 * an unresolved candidate this pass never got a chance to touch. Fixing the
 * "before" half of the race by moving the comparison later did not fix the
 * "after" half; it relocated it.
 *
 * The actual fix (this revision) is to stop taking two snapshots at all.
 * `resolveFlowsheetAlbumIds`/`resolveRotationAlbumIds` compute `candidates`
 * and `resolved` inside one data-modifying CTE: `cohort` is selected once,
 * and `upd` updates exactly `cohort`'s rows, so both counts are read off the
 * same snapshot in the same statement. A concurrent write that *commits
 * before* this statement's snapshot is taken is already reflected in
 * `cohort` and gets updated; a concurrent write that commits *after* the
 * statement finishes is invisible to this run and picked up next slot. Both
 * of those are genuinely benign, and neither shows up as a shortfall.
 *
 * What one snapshot does NOT do is make this statement immune to writers
 * that commit WHILE it is running. A row already inside `cohort` can still
 * be concurrently UPDATEd or DELETEd mid-statement; Postgres's own
 * concurrency control (EvalPlanQual, READ COMMITTED) re-checks the `upd`
 * CTE's WHERE clause against that row's newly-committed version before
 * writing it. A concurrent DELETE makes the row vanish from underneath the
 * UPDATE — nothing left to re-check, so `upd` silently skips it — and a
 * concurrent UPDATE that changes a column the WHERE clause tests (this is
 * exactly why `f.album_id IS NULL AND r.album_id IS NULL` must stay in the
 * `upd` arm, not just `cohort` — see BS#2071's second pass, `git log` on this
 * file) can make the re-checked qual fail too. Either way `upd` returns one
 * fewer row than `cohort` counted, so `resolved < candidates` for a run that
 * did everything right: it drained every row it could still legitimately
 * touch, and something else took the rest out of contention in the same
 * instant. One statement guarantees one *snapshot* for both counts — it does
 * not guarantee `resolved === candidates`, and nothing here should claim it
 * does. A shortfall is evidence to log, not proof of a stuck UPDATE; signal
 * (c) exists to make that evidence visible, not to declare it impossible.
 *
 * A zero-candidate real run reports `residual: 0` — a healthy idle run must
 * never alert. A dry run never reaches the UPDATE at all, so its
 * `PassResult.residual` is `null`, not `0` (see `PassResult`'s docblock);
 * `hasUnresolvedResidue` treats `null` the same as "nothing to report."
 *
 * BS#2413 adds a third `null` case for the same reason: a pass that stood
 * down on lock contention never ran its UPDATE, so it has no drain
 * measurement either. It must not reach signal (c) — "the UPDATE did not
 * resolve what it found" would be a claim about a cohort the pass never
 * looked at — and gets its own `lock_contention` warning instead.
 */
export const hasUnresolvedResidue = ({ residual }: PassResult): boolean => residual !== null && residual > 0;

/**
 * Signal (b), read side. `getLastRunTimestamp` is called here **only** to
 * report how long the job was away; the value never reaches a repair predicate.
 * See the no-time-bound note on `resolveFlowsheetAlbumIds`.
 */
const reportRunGap = async (startedAt: Date): Promise<void> => {
  const lastRunMs = await getLastRunTimestamp(JOB_NAME);
  if (lastRunMs === null) {
    log('info', 'gap-check', 'No prior heartbeat; first run since liveness landed.', { last_run: null });
    return;
  }

  const gap = gapHours(lastRunMs, startedAt.getTime());
  const maxGap = resolveMaxRunGapHours();
  log('info', 'gap-check', 'Elapsed since last successful run.', {
    last_run: new Date(lastRunMs).toISOString(),
    gap_hours: Number(gap.toFixed(2)),
    max_gap_hours: maxGap,
  });

  if (gap > maxGap) {
    captureWarning(`${JOB_NAME}.run_gap_exceeded`, 'gap-check', {
      last_run: new Date(lastRunMs).toISOString(),
      gap_hours: Number(gap.toFixed(2)),
      max_gap_hours: maxGap,
      cron_schedule: CRON_SCHEDULE,
    });
  }
};

/** Both passes, in run order, for the per-pass reporters below. */
const passesOf = (result: RunResult) =>
  [
    ['flowsheet', result.flowsheet],
    ['rotation', result.rotation],
  ] as const;

/** True when either pass stood down on lock contention rather than repairing. */
export const hasLockContention = (result: RunResult): boolean => result.flowsheet.deferred || result.rotation.deferred;

/**
 * BS#2413. A stand-down is reported on its own fingerprint, never folded into
 * signal (c)'s `unresolved_candidates`: that warning asserts "the UPDATE did
 * not resolve what it found", and a pass that never ran its UPDATE has not
 * earned that claim — it would be a report on a cohort it never looked at.
 *
 * Warning, not error, and the run still exits zero. The point of the guard is
 * to convert a five-minute burn ending in a generic `Failed query` into a
 * cheap, correctly-named skip; re-raising it as a failure would put back the
 * "error a human then has to interpret" this is replacing. The skip is not
 * silent, though: it warns here, it withholds the heartbeat (so signal (b)
 * escalates if collisions persist past `LINKAGE_RESOLVE_MAX_GAP_HOURS`), and
 * `candidates` records how much repair was deferred.
 */
const reportLockContention = (result: RunResult): void => {
  for (const [pass, passResult] of passesOf(result)) {
    if (!passResult.deferred) continue;
    log('warn', `lock-${pass}`, 'Stood down on lock contention; repair deferred to the next slot.', {
      pass,
      candidates: passResult.candidates,
      lock_timeout_ms: LINKAGE_LOCK_TIMEOUT_MS,
    });
    captureWarning(`${JOB_NAME}.lock_contention`, `lock-${pass}`, {
      pass,
      candidates: passResult.candidates,
      lock_timeout_ms: LINKAGE_LOCK_TIMEOUT_MS,
      cron_schedule: CRON_SCHEDULE,
    });
  }
};

/** Signal (c). Emits at most one warning per pass, fingerprinted by step. */
const reportDrain = (result: RunResult): void => {
  for (const [pass, passResult] of passesOf(result)) {
    if (!hasUnresolvedResidue(passResult)) continue;
    log('warn', `drain-${pass}`, 'Drain check found candidates the UPDATE did not resolve.', {
      candidates: passResult.candidates,
      resolved: passResult.resolved,
      residual: passResult.residual,
    });
    captureWarning(`${JOB_NAME}.unresolved_candidates`, `drain-${pass}`, {
      pass,
      candidates: passResult.candidates,
      resolved: passResult.resolved,
      residual: passResult.residual,
    });
  }
};

/**
 * One execution with its liveness signals attached.
 *
 * A dry run deliberately skips all of them: it must not send a check-in Sentry
 * would read as a scheduled execution, must not advance the heartbeat, would
 * trip (c) trivially (it counts candidates and writes nothing by design), and
 * cannot reach (d) because it issues no UPDATE to be blocked.
 */
export const runOnce = async (dryRun: boolean): Promise<RunResult> => {
  if (dryRun) return runResolve(true);

  const startedAt = new Date();
  // Fail-open: the repair is the job, the gap report is telemetry about it. A
  // malformed LINKAGE_RESOLVE_MAX_GAP_HOURS or an unreachable `cronjob_runs`
  // must not stop the run — and must not skip the check-in below, which would
  // turn an observability fault into a phantom "cron is down" alert.
  try {
    await reportRunGap(startedAt);
  } catch (error) {
    log('warn', 'gap-check', 'Gap check failed; continuing with the repair.', { error: errorMessage(error) });
    captureError(error, 'gap-check');
  }

  // (a) + (b). The heartbeat is inside the monitored callback so a THROWN run
  // cannot check in `ok` with the repair half-done. `withMonitor` re-throws,
  // so the caller's catch is unchanged.
  //
  // BS#2413: a run in which either pass stood down on lock contention
  // deliberately does NOT advance the heartbeat. Signal (b) measures the gap
  // between *successful* runs, and a stand-down repaired nothing — stamping
  // it would make a collision that persists for hours read as healthy, which
  // is the one thing the gap warning exists to catch.
  //
  // That is the one case where `ok` and the heartbeat part company, and it is
  // deliberate: a stand-down is a run that HAPPENED, which is all signal (a)
  // claims, so it checks in `ok` while (b)'s gap keeps growing and (d) names
  // the reason. Do not read a green cron check-in as proof the heartbeat
  // advanced — `reportLockContention`'s warning is what distinguishes them.
  let deferred = false;
  const result = await Sentry.withMonitor(
    JOB_NAME,
    async () => {
      const passes = await runResolve(false);
      deferred = hasLockContention(passes);
      if (!deferred) await updateLastRun(JOB_NAME, startedAt);
      return passes;
    },
    MONITOR_CONFIG
  );

  if (deferred) {
    log('warn', 'heartbeat', 'Heartbeat NOT advanced: a pass stood down before repairing.', {
      last_run: null,
    });
  } else {
    log('info', 'heartbeat', 'Recorded cronjob_runs heartbeat.', { last_run: startedAt.toISOString() });
  }
  reportDrain(result);
  reportLockContention(result);
  return result;
};

// ---- Main ----

const run = async () => {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  log('info', 'start', dryRun ? 'Starting linkage resolve (dry run).' : 'Starting linkage resolve.', {
    dry_run: dryRun,
  });

  let exitCode = 0;
  try {
    const result = await runOnce(dryRun);
    const deferred = hasLockContention(result);
    log('info', 'complete', deferred ? 'Linkage resolve complete (a pass stood down).' : 'Linkage resolve complete.', {
      dry_run: dryRun,
      flowsheet_resolved: result.flowsheet.resolved,
      rotation_resolved: result.rotation.resolved,
      // BS#2413: `…_resolved: 0` on a stand-down means "did not run", not
      // "found nothing" — the two are the exact pair this job's liveness work
      // exists to keep distinguishable, so the terminal line says which.
      deferred,
    });
  } catch (error) {
    exitCode = 1;
    log('error', 'failed', 'Linkage resolve failed.', { error: errorMessage(error) });
    captureError(error, 'failed');
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
  process.exit(exitCode);
};

// `run` catches everything internally and exits with its own code, so there is
// no rejection to handle here. Guard the auto-invoke so jest's module load
// doesn't fire a stray run (and a `process.exit`) against the mocked DB — jest
// sets NODE_ENV='test'; production runs leave it unset, which executes `run()`.
if (process.env.NODE_ENV !== 'test') {
  void run();
}
