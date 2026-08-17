/**
 * Orchestrator for jobs/flowsheet-no-match-recheck (BS#2176).
 *
 * The recurring, cause-agnostic mechanism the ticket exists to introduce:
 * `flowsheet.metadata_status = 'enriched_no_match'` is terminal, but the
 * condition it records is not permanent — a playcut can be a correct
 * no-match at write time and become resolvable days later when
 * discogs-etl's next rebuild caches the release, an LML matcher fix ships,
 * or the librarian files the album. This sweep re-asks LML for a bounded
 * slice of that cohort every run, ordered oldest-recheck-attempted-first
 * (see `query.ts`), so no future freeze cause needs its own one-shot drain.
 *
 * Structural donor: `jobs/rotation-release-id-backfill/orchestrate.ts` — the
 * same attempt-marker + no-match-TTL + cooperative-pause shape, adapted for
 * `flowsheet`'s two write paths (linked via `album_metadata`, unlinked
 * inline) instead of a single-column UPDATE. The `write` dependency owns
 * that branch (see `writer.ts`); this file stays shape-agnostic about it.
 *
 * `lookup` is expected to gate every match through the track-context trust
 * predicate (`isTrustedLmlTrackContextMatch`, BS#1359/#1959) before
 * returning `{ kind: 'resolved' }` — see `lml-fetch.ts`. This file never
 * inspects `search_type` itself.
 */

import {
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  LIVE_ACTIVITY_MAX_PAUSE_MS_ENV,
  resolveLiveActivityPauseMs as resolveLiveActivityPauseMsShared,
  resolveLiveActivityMaxPauseMs as resolveLiveActivityMaxPauseMsShared,
  buildWaitForQuietPeriod,
  checkLiveActivity as defaultCheckLiveActivity,
  requireNonNegativeInt,
  type CheckLiveActivityFn,
} from '@wxyc/database';
import type { DiscogsMatchResult } from '@wxyc/lml-client';

import { log, captureError } from './logger.js';

export type Candidate = {
  id: number;
  artist_name: string;
  album_title: string | null;
  track_title: string | null;
  // Non-null routes the match write through the album_metadata fill-null
  // UPSERT; null routes it through the flowsheet inline fill-null UPDATE
  // (free-form entries) — see writer.ts.
  album_id: number | null;
  // BS#1294-style pre-read via query.ts's LEFT JOIN; forwarded to the
  // lookupMetadata BS#1293 gate. Optional — absent in hand-built test
  // fixtures that predate this field, and lookup() treats undefined the
  // same as false.
  discogs_unavailable?: boolean;
};

export type LoadCandidatesFn = () => Promise<Candidate[]>;

/**
 * Outcome of one LML lookup. `trust_rejected` is distinct from `no_match`
 * for the same BS#1516 reason rotation-release-id-backfill separates them:
 * `trust_rejected` rows had an LML answer that was refused by the track-
 * context trust gate (a same-artist substitution, not a real match for this
 * track); `no_match` rows had no candidate at all.
 */
export type LookupOutcome =
  | { kind: 'resolved'; artwork: DiscogsMatchResult }
  | { kind: 'no_match' }
  | { kind: 'trust_rejected'; searchType: string };

export type LookupFn = (candidate: Candidate) => Promise<LookupOutcome>;

export type WriteFn = (candidate: Candidate, artwork: DiscogsMatchResult) => Promise<{ written: boolean }>;
export type MarkAttemptedFn = (rowId: number) => Promise<{ written: boolean }>;

export type Totals = {
  scanned: number;
  resolved: number;
  resolved_dry: number;
  unresolved: number;
  trust_rejected: number;
  lml_error: number;
  raced: number;
  db_error: number;
};

export type RunResult = { totals: Totals };

export const resolveLiveActivityLookback = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS
): number =>
  requireNonNegativeInt(raw, 'LIVE_ACTIVITY_LOOKBACK_SECONDS', LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT, {
    note: 'Use 0 to disable the cooperative pause.',
  });

export const resolveLiveActivityPauseMs = (raw: string | undefined = process.env.LIVE_ACTIVITY_PAUSE_MS): number =>
  resolveLiveActivityPauseMsShared(raw, 'LIVE_ACTIVITY_PAUSE_MS');

export const resolveLiveActivityMaxPauseMs = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_MAX_PAUSE_MS
): number => resolveLiveActivityMaxPauseMsShared(raw, LIVE_ACTIVITY_MAX_PAUSE_MS_ENV);

type AttemptBucket = 'unresolved' | 'trust_rejected';

const incrementAttemptBucket = (totals: Totals, bucket: AttemptBucket): void => {
  switch (bucket) {
    case 'unresolved':
      totals.unresolved += 1;
      return;
    case 'trust_rejected':
      totals.trust_rejected += 1;
      return;
  }
};

export const runNoMatchRecheck = async (deps: {
  loadCandidates: LoadCandidatesFn;
  lookup: LookupFn;
  write: WriteFn;
  markAttempted: MarkAttemptedFn;
  dryRun?: boolean;
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
  /** Cumulative cooperative-pause budget ceiling; 0 = uncapped. */
  liveActivityMaxPauseMs?: number;
  checkLiveActivity?: CheckLiveActivityFn;
  onLivePause?: () => void;
}): Promise<RunResult> => {
  const totals: Totals = {
    scanned: 0,
    resolved: 0,
    resolved_dry: 0,
    unresolved: 0,
    trust_rejected: 0,
    lml_error: 0,
    raced: 0,
    db_error: 0,
  };

  const liveActivityLookbackSeconds = deps.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const liveActivityPauseMs = deps.liveActivityPauseMs ?? resolveLiveActivityPauseMs();
  const liveActivityMaxPauseMs = deps.liveActivityMaxPauseMs ?? resolveLiveActivityMaxPauseMs();
  const probe = deps.checkLiveActivity ?? defaultCheckLiveActivity;

  const waitForQuietPeriod = buildWaitForQuietPeriod({
    lookbackSeconds: liveActivityLookbackSeconds,
    pauseMs: liveActivityPauseMs,
    maxTotalPauseMs: liveActivityMaxPauseMs,
    probe,
    onPause: () => deps.onLivePause?.(),
    onProbeError: (error) => {
      log('warn', 'probe_error', 'checkLiveActivity threw; assuming no activity', {
        error_message: error instanceof Error ? error.message : String(error),
      });
      captureError(error, 'probe_error');
    },
    onBudgetExhausted: (pausedMs) => {
      log(
        'error',
        'live_activity_pause_ceiling_exceeded',
        `cooperative-pause budget exceeded (${pausedMs}ms >= LIVE_ACTIVITY_MAX_PAUSE_MS=${liveActivityMaxPauseMs}ms); aborting instead of pausing indefinitely`,
        { paused_ms: pausedMs, live_activity_max_pause_ms: liveActivityMaxPauseMs }
      );
    },
  });

  const recordAttemptedOutcome = async (rowId: number, bucket: AttemptBucket): Promise<void> => {
    if (deps.dryRun) {
      incrementAttemptBucket(totals, bucket);
      return;
    }
    let written: boolean;
    try {
      ({ written } = await deps.markAttempted(rowId));
    } catch {
      // Isolate a transient DB failure to this row instead of throwing out
      // of the loop and abandoning every remaining candidate. The marker
      // stays at its prior value, so the row is retried on a later pass —
      // same "stay retryable" guarantee as `lml_error` below.
      totals.db_error += 1;
      return;
    }
    if (written) {
      incrementAttemptBucket(totals, bucket);
    } else {
      // The marker UPDATE guards on `metadata_status = 'enriched_no_match'`,
      // so 0 rows means some other writer (a concurrent run, the live CDC
      // worker touching an unrelated status, manual triage) already moved
      // the row off that status between our SELECT and this UPDATE.
      totals.raced += 1;
    }
  };

  const candidates = await deps.loadCandidates();
  // BS#2176 acceptance criterion: report the candidate count / projected LML
  // call volume as soon as candidates are loaded — before any lookup or
  // write, in both dry-run and live runs. This job is single-row (never
  // bulk), so the projection is exact: one candidate is at most one LML call.
  log('info', 'candidates_loaded', `${candidates.length} candidate row(s) loaded`, {
    candidates: candidates.length,
    projected_lml_calls: candidates.length,
    dry_run: deps.dryRun ?? false,
  });
  for (const candidate of candidates) {
    await waitForQuietPeriod();

    totals.scanned += 1;
    let outcome: LookupOutcome;
    try {
      outcome = await deps.lookup(candidate);
    } catch {
      // The row stays `metadata_status = 'enriched_no_match'` with its
      // marker untouched, so it is retried on the next pass once LML (or
      // whatever transient condition caused the throw) recovers. The job
      // entry (job.ts) wraps the orchestrator's loop in Sentry's run-scope
      // so captureError is unnecessary here at the unit boundary.
      totals.lml_error += 1;
      continue;
    }
    if (outcome.kind === 'trust_rejected') {
      await recordAttemptedOutcome(candidate.id, 'trust_rejected');
      continue;
    }
    if (outcome.kind === 'no_match') {
      await recordAttemptedOutcome(candidate.id, 'unresolved');
      continue;
    }
    if (deps.dryRun) {
      totals.resolved_dry += 1;
      continue;
    }
    let written: boolean;
    try {
      ({ written } = await deps.write(candidate, outcome.artwork));
    } catch {
      // Isolate a transient DB failure to this row rather than aborting the
      // batch. The row stays `enriched_no_match` and unmarked, so it is
      // retried on the next pass.
      totals.db_error += 1;
      continue;
    }
    if (written) {
      totals.resolved += 1;
    } else {
      // The writer's WHERE clause guards on `metadata_status =
      // 'enriched_no_match'`; 0 rows updated means a concurrent writer won
      // the race between our SELECT and our UPDATE.
      totals.raced += 1;
    }
  }

  return { totals };
};
