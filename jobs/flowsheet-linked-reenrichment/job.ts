/**
 * One-shot re-enrichment of the BS#1443 `enriched_no_match` linked cohort —
 * Lane A (BS#1638).
 *
 * Clears the 22,773 flowsheet rows stuck at terminal
 * `metadata_status='enriched_no_match'` with `album_id IS NOT NULL` that no
 * automated path revisits (the CDC consumer fires on INSERT only, the sweep
 * targets `enriching`, and the metadata-backfill cron keys on
 * `metadata_attempt_at IS NULL`). The parent decision ticket (BS#1443) chose
 * Option 1 (one-shot re-enrichment) over Option 2 (re-arm the cron by
 * resetting `pending` + `metadata_attempt_at=NULL`) precisely so this job
 * leaves BS#1011's drain-completion signal and BS#895's C6 retune untouched:
 * it NEVER sets `metadata_status='pending'` and NEVER writes
 * `metadata_attempt_at`.
 *
 * The frozen cohort predicate (re-verified live 2026-07-13, exactly 22,773
 * rows) is applied in full to every SELECT and every UPDATE:
 *
 *   metadata_status = 'enriched_no_match'
 *   AND album_id IS NOT NULL
 *   AND artist_name IS NOT NULL
 *   AND add_time < '2026-06-16T17:53:53Z'::timestamptz
 *
 * NB: no `entry_type = 'track'` narrow. BS#1443's audit froze the count at
 * exactly these four clauses; adding a fifth risks stranding a non-track
 * cohort row that no automated path would ever revisit.
 *
 * LANE A (this package) — pure SQL, zero LML calls. Cohort rows whose
 * `album_id` already has a *populated* `album_metadata` row (`discogs_url IS
 * NOT NULL OR artwork_url IS NOT NULL`) flip to `enriched_match`. ~15,231
 * rows / 523 albums. Linked-row reads JOIN `album_metadata`, so no per-row
 * metadata columns need writing (same as jobs/album-level-backfill/job.ts's
 * paired post-pass UPDATE). Batched (docs/bulk-update-playbook.md) with an
 * `ANALYZE flowsheet` after.
 *
 * LANE B (LML re-lookup of the ~314 residual albums with a fill-null
 * `album_metadata` UPSERT) lands in the chained follow-up PR. It reuses this
 * file's cohort predicate + flip machinery, so keeping the two lanes in
 * separate PRs stages the rollout: Lane A drains ~15k of the 22.7k rows with
 * zero external dependency and can be verified in production before Lane B's
 * LML surface exists.
 *
 * Structural donor: jobs/album-level-backfill/job.ts (BS#1041). Sibling:
 * jobs/flowsheet-reenrichment (BS#1433) drained the *unlinked* (`album_id IS
 * NULL`) cohort and documented this linked cohort as the "match_raced orphan"
 * rescue target; this job is that rescue.
 *
 * DRY-RUN IS THE DEFAULT — the container performs the scope SELECT and logs
 * the planned count with zero writes. Pass `--execute` to write. See
 * README.md for the run procedure (out-of-band partial index pre-flight,
 * off-peak window).
 */

import { sql } from 'drizzle-orm';
import {
  db,
  closeDatabaseConnection,
  checkLiveActivity,
  requireNonNegativeInt,
  requirePositiveInt,
} from '@wxyc/database';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'flowsheet-linked-reenrichment';

/**
 * Frozen cohort `add_time` upper bound (BS#1443, re-verified 2026-07-13).
 * A hard-coded literal, never operator-configurable — widening it would pull
 * in rows the parent audit never scoped. Bound as a SQL param (no injection
 * surface; it is a compile-time constant).
 */
export const COHORT_ADD_TIME_CUTOFF = '2026-06-16T17:53:53Z';

// -- Env knobs ---------------------------------------------------------------

/** Rows flipped per Lane A UPDATE transaction. Batched per
 * docs/bulk-update-playbook.md so each transaction is short and the CDC
 * NOTIFY queue can't backpressure on the ~15k-row flip. */
export const FLIP_BATCH_SIZE_ENV = 'LINKED_REENRICH_FLIP_BATCH_SIZE';
export const FLIP_BATCH_SIZE_DEFAULT = 5000;

/** Statement timeout for each flip batch. */
export const FLIP_TIMEOUT_ENV = 'LINKED_REENRICH_FLIP_TIMEOUT_MS';
export const FLIP_TIMEOUT_DEFAULT = 5 * 60 * 1000;

/** Statement timeout for the count SELECT. The cohort predicate is covered by
 * the out-of-band partial index the README asks the operator to build
 * (`flowsheet_linked_reenrichment_idx`); 5min is a wide margin even if that
 * pre-flight was skipped and the scan degrades. */
export const READ_TIMEOUT_ENV = 'LINKED_REENRICH_READ_TIMEOUT_MS';
export const READ_TIMEOUT_DEFAULT = 5 * 60 * 1000;

/** Cooperative-pause lookback. If the most recent flowsheet track was added
 * within this window, defer. Default 300s (5 min) mirrors the donor — the
 * flip transactions hold write locks and we don't want them racing live
 * inserts. `0` disables the probe (catch-up). */
export const LIVE_ACTIVITY_LOOKBACK_ENV = 'LIVE_ACTIVITY_LOOKBACK_SECONDS';
export const LIVE_ACTIVITY_LOOKBACK_DEFAULT = 300;

/** Sleep between re-probes when DJ activity is detected. */
export const LIVE_ACTIVITY_PAUSE_MS_DEFAULT = 30_000;

// -- Cohort predicate --------------------------------------------------------

/** The frozen four-clause cohort predicate on a flowsheet alias `f`. Shared
 * by the Lane A flip and the Lane A scope count so they can never drift.
 * (Lane B's residual enumeration will reuse the same fragment.) */
const cohortPredicate = sql`
  f."metadata_status" = 'enriched_no_match'
  AND f."album_id" IS NOT NULL
  AND f."artist_name" IS NOT NULL
  AND f."add_time" < ${COHORT_ADD_TIME_CUTOFF}::timestamptz
`;

/** A populated `album_metadata` row is one with a real Discogs match signal.
 * Both-null rows (the stored no-match shape) are NOT populated and fall to
 * Lane B. Applied to an `album_metadata` alias `am`. */
const populatedAlbumMetadata = sql`(am."discogs_url" IS NOT NULL OR am."artwork_url" IS NOT NULL)`;

// -- Lane A: scope count -----------------------------------------------------

/** COUNT of cohort rows whose album already has populated metadata — the
 * "SELECT with the same WHERE first" the data-safety constraint asks for,
 * logged before the flip lane runs. */
export const countPopulatedFlipCandidates = async (timeoutMs: number = READ_TIMEOUT_DEFAULT): Promise<number> => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const rows = (await tx.execute(sql`
      SELECT count(*)::int AS count
      FROM "wxyc_schema"."flowsheet" f
      JOIN "wxyc_schema"."album_metadata" am ON am."album_id" = f."album_id"
      WHERE ${cohortPredicate}
        AND ${populatedAlbumMetadata}
    `)) as unknown as Array<{ count: number | string }>;
    return Number(rows?.[0]?.count ?? 0);
  });
};

// -- Lane A: the flip --------------------------------------------------------

/** Flip a single batch of cohort rows whose `album_id` now has populated
 * `album_metadata`. Wrapped in a transaction so `SET LOCAL statement_timeout`
 * applies (postgres-js auto-commits per execute otherwise). Returns the batch
 * size flipped. The `LIMIT` bounds the transaction; flipped rows leave the
 * `enriched_no_match` predicate so the next batch takes the next lowest ids —
 * a self-advancing cursor with no offset bookkeeping. The SET writes a
 * literal (`enriched_match`), never a COALESCE that could collapse to the
 * pre-flip value, so the loop always narrows (docs/bulk-update-playbook.md
 * infinite-loop pitfall). NB: `metadata_attempt_at` is deliberately left
 * untouched (BS#1011 / BS#895 invariant). */
export const flipBatch = async (batchSize: number, timeoutMs: number): Promise<number> => {
  return await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}ms'`));
    const result = await tx.execute(sql`
      WITH batch AS (
        SELECT f."id"
        FROM "wxyc_schema"."flowsheet" f
        JOIN "wxyc_schema"."album_metadata" am ON am."album_id" = f."album_id"
        WHERE ${cohortPredicate}
          AND ${populatedAlbumMetadata}
        ORDER BY f."id"
        LIMIT ${batchSize}
      )
      UPDATE "wxyc_schema"."flowsheet" f
      SET "metadata_status" = 'enriched_match'
      FROM batch
      WHERE f."id" = batch."id"
      RETURNING f."id"
    `);
    return (result as unknown as Array<{ id: number }>).length;
  });
};

/** Drive `flipBatch` until a batch flips 0 rows. Returns the total flipped.
 * Cooperative pause is checked before each batch so a DJ going live mid-drain
 * defers the next transaction (never interrupts an in-flight one). The `lane`
 * tag distinguishes Lane A's flip from Lane B's paired post-lookup flip in
 * the logs. */
export const flipPopulatedCohort = async (
  lane: 'lane_a' | 'lane_b',
  batchSize: number,
  timeoutMs: number,
  liveActivityLookbackSeconds: number,
  liveActivityPauseMs: number
): Promise<number> => {
  let total = 0;
  let batchIndex = 0;
  for (;;) {
    await awaitQuietWindow(liveActivityLookbackSeconds, liveActivityPauseMs);
    const t0 = Date.now();
    const flipped = await flipBatch(batchSize, timeoutMs);
    total += flipped;
    batchIndex += 1;
    log('info', 'flip_batch_done', `${lane} flip batch ${batchIndex} flipped ${flipped}`, {
      lane,
      batch_index: batchIndex,
      flipped,
      total_flipped: total,
      wall_clock_ms: Date.now() - t0,
    });
    if (flipped === 0) break;
  }
  return total;
};

// -- Cooperative pause -------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Loop: probe → if a DJ added a track within the lookback, sleep → re-probe.
 * Returns when the window is quiet. Uses the shared `checkLiveActivity`
 * (@wxyc/database) backed by migration 0050's partial index. */
export const awaitQuietWindow = async (lookbackSeconds: number, pauseMs: number): Promise<void> => {
  while (await checkLiveActivity(lookbackSeconds)) {
    log('info', 'live_activity_pause', `live DJ activity within ${lookbackSeconds}s; deferring ${pauseMs}ms`, {
      lookback_seconds: lookbackSeconds,
      pause_ms: pauseMs,
    });
    await sleep(pauseMs);
  }
};

// -- ANALYZE -----------------------------------------------------------------

export const analyzeFlowsheet = async (): Promise<void> => {
  log('info', 'analyze_started', 'ANALYZE flowsheet');
  await db.execute(sql`ANALYZE "wxyc_schema"."flowsheet"`);
};

// -- Top-level orchestration -------------------------------------------------

export interface ReenrichmentSummary {
  /** Lane A scope count logged before the flip. */
  lane_a_candidates: number;
  /** Rows flipped to enriched_match from populated album_metadata. */
  flipped_from_album_metadata: number;
  lane_a_flipped: number;
  dry_run: boolean;
}

export interface ReenrichmentOptions {
  flipBatchSize: number;
  flipTimeoutMs: number;
  readTimeoutMs: number;
  liveActivityLookbackSeconds: number;
  liveActivityPauseMs: number;
  dryRun: boolean;
}

/** Dry-run is the DEFAULT; writes require `--execute`. `--dry-run` is an
 * explicit no-op accepted for self-documenting run commands; passing both is
 * a fat-finger worth failing fast on. (apple-music-url-backfill pattern.) */
export const resolveDryRun = (argv: string[] = process.argv): boolean => {
  const execute = argv.includes('--execute');
  const dryRun = argv.includes('--dry-run');
  if (execute && dryRun) {
    throw new Error('Contradictory flags: pass either --execute or --dry-run (the default), not both.');
  }
  return !execute;
};

export const resolveOptions = (
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv
): ReenrichmentOptions => {
  const ctx = { context: JOB_NAME };
  return {
    flipBatchSize: requirePositiveInt(env[FLIP_BATCH_SIZE_ENV], FLIP_BATCH_SIZE_ENV, FLIP_BATCH_SIZE_DEFAULT, ctx),
    flipTimeoutMs: requirePositiveInt(env[FLIP_TIMEOUT_ENV], FLIP_TIMEOUT_ENV, FLIP_TIMEOUT_DEFAULT, ctx),
    readTimeoutMs: requirePositiveInt(env[READ_TIMEOUT_ENV], READ_TIMEOUT_ENV, READ_TIMEOUT_DEFAULT, ctx),
    liveActivityLookbackSeconds: requireNonNegativeInt(
      env[LIVE_ACTIVITY_LOOKBACK_ENV],
      LIVE_ACTIVITY_LOOKBACK_ENV,
      LIVE_ACTIVITY_LOOKBACK_DEFAULT,
      { ...ctx, unit: 's', note: 'Use 0 to disable the cooperative pause.' }
    ),
    liveActivityPauseMs: LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
    dryRun: resolveDryRun(args),
  };
};

export const runReenrichment = async (options: ReenrichmentOptions): Promise<ReenrichmentSummary> => {
  log('info', 'started', `${JOB_NAME} starting`, {
    dry_run: options.dryRun,
    flip_batch_size: options.flipBatchSize,
  });

  const summary: ReenrichmentSummary = {
    lane_a_candidates: 0,
    flipped_from_album_metadata: 0,
    lane_a_flipped: 0,
    dry_run: options.dryRun,
  };

  // ---- Lane A: flip from existing populated album_metadata ----------------
  summary.lane_a_candidates = await countPopulatedFlipCandidates(options.readTimeoutMs);
  log('info', 'lane_a_scope', `Lane A: ${summary.lane_a_candidates} cohort rows joinable to populated metadata`, {
    lane_a_candidates: summary.lane_a_candidates,
  });

  if (options.dryRun) {
    log('info', 'finished', `${JOB_NAME} done (dry-run)`, { ...summary });
    return summary;
  }

  summary.lane_a_flipped = await flipPopulatedCohort(
    'lane_a',
    options.flipBatchSize,
    options.flipTimeoutMs,
    options.liveActivityLookbackSeconds,
    options.liveActivityPauseMs
  );
  if (summary.lane_a_flipped > 0) await analyzeFlowsheet();

  summary.flipped_from_album_metadata = summary.lane_a_flipped;
  log('info', 'finished', `${JOB_NAME} done`, { ...summary });
  return summary;
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });

  try {
    const options = resolveOptions();
    await runReenrichment(options);
  } catch (err) {
    captureError(err, 'main');
    log('error', 'failed', `${JOB_NAME} failed: ${err instanceof Error ? err.message : String(err)}`, {
      error_message: err instanceof Error ? err.message : String(err),
      error_name: err instanceof Error ? err.name : null,
    });
    process.exitCode = 1;
  } finally {
    await closeLogger();
    await closeDatabaseConnection();
  }
};

// Guard the auto-invoke so jest's module load doesn't fire a stray run
// against the mocked DB (NODE_ENV='test' under jest; production leaves it
// 'production' or unset).
if (process.env.NODE_ENV !== 'test') {
  void main();
}
