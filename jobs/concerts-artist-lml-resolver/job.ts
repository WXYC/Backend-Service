/**
 * Daily cron: resolve clean unresolved concert headliner AND support names
 * to Discogs artist ids via LML's verify-before-mint bulk endpoint
 * (BS#1614 headliner, BS#1763 support; LML#759).
 *
 * The pure-SQL strict/alias resolver (`jobs/concerts-artist-resolver/`,
 * 05:15 UTC) can only FK names the WXYC library knows; the residual is
 * touring artists WXYC never cataloged — headliners AND their support
 * acts. This job sends the CLEAN subset of that residual (`isCleanHeadliner`
 * — the API-budget gate co-located with the extraction rules in
 * `jobs/triangle-shows-etl/headliner.ts`, applied to both roles) to
 * `POST /api/v1/artists/resolve/bulk`, which mints only on exactly one
 * exact-form Discogs candidate with no cache conflict — so a billing
 * string that slips through the gate lands `not_found`, never a wrong id.
 *
 * Sequenced at 05:35 UTC: after the 05:05 triangle-shows pull and the
 * 05:15 SQL resolver, so the cheap SQL arms get first claim each cycle and
 * this job only sees their residual. The LML#759 live drain pre-warmed
 * `entity.identity` for the backlog, so the first run resolves mostly via
 * the identity_store tier (no Discogs API calls) — no one-shot mode needed.
 *
 * Retry policy is the `artist_resolve_attempted_at` attempt-at marker
 * (docs/migrations.md "Attempt-at markers"): stamped on responded verdicts
 * (resolved / ambiguous / not_found), left NULL on escalation_unavailable
 * and transport errors, re-attempted when NULL or older than the no-match
 * TTL. Verdict routing and the all-escalation early stop live in
 * orchestrate.ts; the headliner and support candidate/write SQL both live
 * in targets.ts. A name billed as both a headliner and a support act
 * resolves ONCE (orchestrate.ts's per-name dedupe is keyed across both
 * registered targets) and fans to both.
 *
 * After `runResolve` finishes, `runJob` recomputes
 * `concerts.has_resolved_support` (`recomputeHasResolvedSupport`,
 * `@wxyc/database` — shared with `jobs/concerts-artist-resolver`'s own
 * step 4) so a support this run resolved via the Discogs-only lane is
 * curated the SAME cron cycle, not one cycle later. Skipped under
 * `--dry-run`, matching `runResolve`'s own no-writes contract.
 *
 * Run procedure: see jobs/concerts-artist-lml-resolver/README.md.
 */

import { sql } from 'drizzle-orm';
import {
  closeDatabaseConnection,
  db,
  recomputeHasResolvedSupport,
  requireNonNegativeInt,
  requirePositiveInt,
} from '@wxyc/database';
import { ARTIST_RESOLVE_BATCH_CAP, resolveArtistNamesBulk } from '@wxyc/lml-client';
import { isCleanHeadliner } from '../triangle-shows-etl/headliner.js';
import { defaultLmlLimiter } from './lml-limiter.js';
import { runResolve, type Totals } from './orchestrate.js';
import { headlinerTarget, supportTarget } from './targets.js';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'concerts-artist-lml-resolver';

// -- Env knobs ---------------------------------------------------------------

/** Names per LML page. Hard-capped at `ARTIST_RESOLVE_BATCH_CAP` (25 — the
 * endpoint's per-request contract); the default of 10 keeps a worst-case
 * fully-escalating page's wall-clock short under LML's serial 50/min Discogs
 * budget. */
export const PAGE_SIZE_ENV = 'CONCERTS_ARTIST_RESOLVE_PAGE_SIZE';
export const PAGE_SIZE_DEFAULT = 10;

/** No-match retry TTL (days). A name that came back `not_found` (a later
 * Discogs addition can match) or `ambiguous` (the family can gain an
 * identity-store pin) is re-asked once its marker is older than this.
 * Marker-NULL rows (never-asked + escalation_unavailable + transport
 * failures) are always eligible regardless of TTL. */
export const NO_MATCH_TTL_DAYS_ENV = 'CONCERTS_ARTIST_RESOLVE_NO_MATCH_TTL_DAYS';
export const NO_MATCH_TTL_DAYS_DEFAULT = 30;

/** Cooperative-pause lookback window (seconds). If the most recent flowsheet
 * track was added within this many seconds, defer. `0` disables the probe. */
export const LIVE_ACTIVITY_LOOKBACK_ENV = 'LIVE_ACTIVITY_LOOKBACK_SECONDS';
export const LIVE_ACTIVITY_LOOKBACK_DEFAULT = 60;

/** Sleep between re-probes when DJ activity is detected. */
export const LIVE_ACTIVITY_PAUSE_MS_DEFAULT = 30_000;

export interface ResolveJobOptions {
  pageSize: number;
  noMatchTtlDays: number;
  liveActivityLookbackSeconds: number;
  liveActivityPauseMs: number;
  dryRun: boolean;
}

export const resolveJobOptions = (
  env: NodeJS.ProcessEnv = process.env,
  args: string[] = process.argv
): ResolveJobOptions => {
  const ctx = { context: JOB_NAME };
  const pageSize = requirePositiveInt(env[PAGE_SIZE_ENV], PAGE_SIZE_ENV, PAGE_SIZE_DEFAULT, ctx);
  if (pageSize > ARTIST_RESOLVE_BATCH_CAP) {
    // Fail fast at parse time with an actionable message — the client would
    // otherwise throw the same ceiling per page after the run started.
    throw new Error(
      `[${JOB_NAME}] ${PAGE_SIZE_ENV}=${pageSize} exceeds the LML per-request cap of ${ARTIST_RESOLVE_BATCH_CAP}.`
    );
  }
  return {
    pageSize,
    noMatchTtlDays: requirePositiveInt(
      env[NO_MATCH_TTL_DAYS_ENV],
      NO_MATCH_TTL_DAYS_ENV,
      NO_MATCH_TTL_DAYS_DEFAULT,
      ctx
    ),
    liveActivityLookbackSeconds: requireNonNegativeInt(
      env[LIVE_ACTIVITY_LOOKBACK_ENV],
      LIVE_ACTIVITY_LOOKBACK_ENV,
      LIVE_ACTIVITY_LOOKBACK_DEFAULT,
      { ...ctx, note: 'Use 0 to disable the live-activity probe.' }
    ),
    liveActivityPauseMs: LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
    dryRun: args.includes('--dry-run'),
  };
};

// -- Cooperative pause -------------------------------------------------------

/** Probe `flowsheet` for a track row added in the last `lookbackSeconds`.
 * Returns `true` when activity is detected. `0` disables the probe.
 * Mirrors `jobs/catalog-popularity-freetext-resolve/job.ts`. */
export const checkLiveActivity = async (lookbackSeconds: number): Promise<boolean> => {
  if (lookbackSeconds <= 0) return false;
  const rows = (await db.execute(sql`
    SELECT 1
    FROM "wxyc_schema"."flowsheet"
    WHERE "entry_type" = 'track'
      AND "add_time" > now() - (interval '1 second' * ${lookbackSeconds})
    LIMIT 1
  `)) as unknown as Array<unknown>;
  return rows.length > 0;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Loop: probe → if active, sleep pauseMs → re-probe. Returns when quiet. */
export const awaitQuietWindow = async (lookbackSeconds: number, pauseMs: number): Promise<void> => {
  while (await checkLiveActivity(lookbackSeconds)) {
    log('info', 'live_activity_pause', `live DJ activity within ${lookbackSeconds}s; deferring ${pauseMs}ms`, {
      lookback_seconds: lookbackSeconds,
      pause_ms: pauseMs,
    });
    await sleep(pauseMs);
  }
};

// -- Entrypoint ----------------------------------------------------------------

export const runJob = async (options: ResolveJobOptions): Promise<Totals> => {
  log('info', 'started', `${JOB_NAME} starting`, {
    page_size: options.pageSize,
    no_match_ttl_days: options.noMatchTtlDays,
    live_activity_lookback_seconds: options.liveActivityLookbackSeconds,
    dry_run: options.dryRun,
  });

  const totals = await runResolve(
    {
      targets: [headlinerTarget, supportTarget],
      gate: isCleanHeadliner,
      resolveBatch: (names) => resolveArtistNamesBulk(names, { limiter: defaultLmlLimiter, caller: JOB_NAME }),
      awaitQuiet: () => awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs),
    },
    {
      pageSize: options.pageSize,
      ttlDays: options.noMatchTtlDays,
      dryRun: options.dryRun,
    }
  );

  // Keep `has_resolved_support` in sync the SAME cycle a support resolves
  // via this job's Discogs-only lane — otherwise the boolean lags until
  // concerts-artist-resolver's own 05:15 recompute the following day.
  // Unconditional (like concerts-artist-resolver's own step 4): the
  // windowed recompute is idempotent and cheap (O(upcoming concerts)), so
  // running it even when this cycle resolved nothing new is a no-op, not a
  // waste. Skipped under --dry-run: runResolve already wrote nothing, so
  // recomputing against unchanged junction state would just repeat a prior
  // no-op read.
  if (!options.dryRun) {
    const recomputeOutcome = await recomputeHasResolvedSupport();
    log('info', 'recompute_finished', `${JOB_NAME} has_resolved_support recompute done`, { ...recomputeOutcome });
  }

  return totals;
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });

  try {
    const options = resolveJobOptions();
    const totals = await runJob(options);
    log('info', 'finished', `${JOB_NAME} done`, { ...totals });
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

// Guard the auto-invoke so jest's module load doesn't fire a stray run against
// the mocked DB. Jest sets NODE_ENV='test'; production runs leave it
// 'production' (per Dockerfile) or unset, both of which execute main().
if (process.env.NODE_ENV !== 'test') {
  void main();
}
