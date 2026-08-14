/**
 * Orchestrator for jobs/rotation-release-id-backfill (BS#1029).
 *
 * Iterates active rotation rows (`kill_date IS NULL OR > CURRENT_DATE`) with
 * NULL `discogs_release_id`, asks LML to resolve `(artist_name, album_title)`
 * to a Discogs release id, and writes the result back to BS PG with
 * `discogs_release_id_source = 'lml_offline_backfill'`. Recurring cron;
 * rerun-safe via the `discogs_release_id IS NULL` SELECT predicate plus a
 * no-match TTL over `discogs_release_id_resolve_attempted_at`.
 *
 * Pacing and per-call timeouts ride on top of `@wxyc/lml-client`'s
 * `defaultLmlLimiter` configured with `BACKFILL_LML_*` env vars — same
 * safety story as `jobs/flowsheet-metadata-backfill` post-BS#995.
 *
 * Cooperative pause (BS#735): the orchestrator probes flowsheet for live DJ
 * activity before each row; disable via `LIVE_ACTIVITY_LOOKBACK_SECONDS=0`
 * for manual catch-up runs.
 *
 * Deps are injected so tests can drive the orchestrator without a live
 * LML or DB.
 */

import {
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  resolveLiveActivityPauseMs as resolveLiveActivityPauseMsShared,
  buildWaitForQuietPeriod,
  checkLiveActivity as defaultCheckLiveActivity,
  requireNonNegativeInt,
  type CheckLiveActivityFn,
} from '@wxyc/database';

export type Candidate = {
  id: number;
  artist_name: string;
  album_title: string;
  // BS#1294 (1c): pre-read via `query.ts`'s LEFT JOIN on `library`; forwarded
  // to the lookupMetadata gate (BS#1293). Optional — absent in hand-built
  // test fixtures that predate this field, and `lookupReleaseId` treats
  // undefined the same as `false`.
  discogs_unavailable?: boolean;
};

export type LoadCandidatesFn = () => Promise<Candidate[]>;

/**
 * Outcome of one LML lookup (BS#1516). `trust_rejected` is distinct from
 * `no_match` because the two demand different operator responses:
 * `trust_rejected` rows have an LML answer we refused (candidates for
 * LML-side match improvements), `no_match` rows have no candidate at all
 * (need Discogs/catalog additions).
 */
export type LookupOutcome =
  { kind: 'resolved'; releaseId: number } | { kind: 'no_match' } | { kind: 'trust_rejected'; searchType: string };

export type LookupFn = (artist: string, album: string, discogsUnavailable?: boolean) => Promise<LookupOutcome>;

export type WriteFn = (rotationId: number, releaseId: number) => Promise<{ written: boolean }>;
export type MarkAttemptedFn = (rotationId: number) => Promise<{ written: boolean }>;

export type Totals = {
  scanned: number;
  resolved: number;
  resolved_dry: number;
  unresolved: number;
  lml_error: number;
  raced: number;
  sentinel_rejected: number;
  trust_rejected: number;
  db_error: number;
};

export type RunResult = { totals: Totals };

export const resolveLiveActivityLookback = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS
): number =>
  requireNonNegativeInt(raw, 'LIVE_ACTIVITY_LOOKBACK_SECONDS', LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT, {
    note: 'Use 0 to disable the cooperative pause.',
  });

/**
 * BS#2147: delegates to the shared floored resolver so `LIVE_ACTIVITY_PAUSE_MS`
 * below `LIVE_ACTIVITY_MIN_PAUSE_MS` (including `0`) is rejected at init
 * instead of degrading the cooperative-pause loop into a hot loop against
 * RDS. `LIVE_ACTIVITY_LOOKBACK_SECONDS=0` remains the sole disable knob.
 */
export const resolveLiveActivityPauseMs = (raw: string | undefined = process.env.LIVE_ACTIVITY_PAUSE_MS): number =>
  resolveLiveActivityPauseMsShared(raw, 'LIVE_ACTIVITY_PAUSE_MS');

type AttemptBucket = 'unresolved' | 'sentinel_rejected' | 'trust_rejected';

const incrementAttemptBucket = (totals: Totals, bucket: AttemptBucket): void => {
  switch (bucket) {
    case 'unresolved':
      totals.unresolved += 1;
      return;
    case 'sentinel_rejected':
      totals.sentinel_rejected += 1;
      return;
    case 'trust_rejected':
      totals.trust_rejected += 1;
      return;
  }
};

export const runBackfill = async (deps: {
  loadCandidates: LoadCandidatesFn;
  lookup: LookupFn;
  write: WriteFn;
  markAttempted: MarkAttemptedFn;
  dryRun?: boolean;
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
  checkLiveActivity?: CheckLiveActivityFn;
  onLivePause?: () => void;
}): Promise<RunResult> => {
  const totals: Totals = {
    scanned: 0,
    resolved: 0,
    resolved_dry: 0,
    unresolved: 0,
    lml_error: 0,
    raced: 0,
    sentinel_rejected: 0,
    trust_rejected: 0,
    db_error: 0,
  };

  const liveActivityLookbackSeconds = deps.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const liveActivityPauseMs = deps.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const probe = deps.checkLiveActivity ?? defaultCheckLiveActivity;

  // BS#2147: the loop itself (probe + elapsed-time cap) now lives in the
  // shared `buildWaitForQuietPeriod`; `deps.onLivePause` is wired through
  // `onPause` so existing unit tests asserting on it keep working
  // unchanged. This job gains fail-open probe-error handling here for the
  // first time — a probe throw used to propagate out of `runBackfill` and
  // abort the whole run; it is now treated as "no activity" for that
  // iteration, matching six of the ten sibling jobs (no `log`/`captureError`
  // available at this layer to report it through, unlike the TS-orchestrator
  // siblings — the throw is simply swallowed). No SIGTERM/stop handling
  // existed here before and none is added.
  const waitForQuietPeriod = buildWaitForQuietPeriod({
    lookbackSeconds: liveActivityLookbackSeconds,
    pauseMs: liveActivityPauseMs,
    probe,
    onPause: () => deps.onLivePause?.(),
  });

  const recordAttemptedOutcome = async (rotationId: number, bucket: AttemptBucket): Promise<void> => {
    if (deps.dryRun) {
      incrementAttemptBucket(totals, bucket);
      return;
    }
    let written: boolean;
    try {
      ({ written } = await deps.markAttempted(rotationId));
    } catch {
      // Isolate a transient DB failure to this row (deadlock, connection
      // reset, …) instead of throwing out of the loop and abandoning every
      // remaining candidate. The marker stays NULL, so the row is retried on
      // the next cron tick — same "stay retryable" guarantee as `lml_error`.
      totals.db_error += 1;
      return;
    }
    if (written) {
      incrementAttemptBucket(totals, bucket);
    } else {
      // Same race shape as `writeReleaseId`: the marker UPDATE guards on
      // `discogs_release_id IS NULL`, so 0 rows means a tubafrenzy paste (or
      // another resolver run) filled the id after candidate selection.
      totals.raced += 1;
    }
  };

  const candidates = await deps.loadCandidates();
  for (const candidate of candidates) {
    await waitForQuietPeriod();

    totals.scanned += 1;
    let outcome: LookupOutcome;
    try {
      outcome = await deps.lookup(candidate.artist_name, candidate.album_title, candidate.discogs_unavailable);
    } catch {
      // The row stays `discogs_release_id IS NULL`, so it's picked up
      // again on the next run when LML's cache is warmer. The job entry
      // (job.ts) wraps the orchestrator's loop in Sentry's run-scope so
      // captureError is unnecessary here at the unit boundary.
      totals.lml_error += 1;
      continue;
    }
    if (outcome.kind === 'trust_rejected') {
      // BS#1516: LML answered, but not with a `direct` match — persisting
      // it would pin a wrong-album release id that tier 1 serves forever
      // (the Yenbett→Tzenni recurrence, BS#1515). The row stays NULL.
      await recordAttemptedOutcome(candidate.id, 'trust_rejected');
      continue;
    }
    if (outcome.kind === 'no_match') {
      await recordAttemptedOutcome(candidate.id, 'unresolved');
      continue;
    }
    const releaseId = outcome.releaseId;
    if (releaseId <= 0) {
      // BS#1429: rotation.discogs_release_id has a CHECK rejecting `0`
      // and negative ids. Pre-empt the constraint trip here so a
      // poisoned LML response (cache pollution, upstream regression)
      // is contained to one candidate counter instead of crashing the
      // whole nightly batch.
      await recordAttemptedOutcome(candidate.id, 'sentinel_rejected');
      continue;
    }
    if (deps.dryRun) {
      totals.resolved_dry += 1;
      continue;
    }
    let written: boolean;
    try {
      ({ written } = await deps.write(candidate.id, releaseId));
    } catch {
      // Isolate a transient DB failure to this row rather than aborting the
      // batch. The row stays `discogs_release_id IS NULL` and unmarked, so it
      // is retried on the next cron tick.
      totals.db_error += 1;
      continue;
    }
    if (written) {
      totals.resolved += 1;
    } else {
      // The writer's WHERE clause guards on `discogs_release_id IS NULL`;
      // 0 rows updated means a tubafrenzy paste won the race between our
      // SELECT and our UPDATE. Surface it on a dedicated counter so the
      // dashboard distinguishes write success from "tubafrenzy beat us".
      totals.raced += 1;
    }
  }

  return { totals };
};
