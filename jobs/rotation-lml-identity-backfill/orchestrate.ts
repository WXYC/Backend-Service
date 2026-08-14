/**
 * Orchestrator for jobs/rotation-lml-identity-backfill (BS#1380).
 *
 * Iterates active rotation rows
 * (`kill_date IS NULL OR > CURRENT_DATE`) where
 * `lml_identity_id IS NULL AND discogs_release_id IS NOT NULL`, asks LML
 * for a stable identity_id via `POST /api/v1/identity/resolve`, and
 * writes the result back. Recurring daily-cron drift-repair (the
 * recurring shape from `jobs/flowsheet-metadata-backfill`, not the
 * one-shot shape from `jobs/rotation-release-id-backfill`); rerun-safe
 * via the SELECT predicate.
 *
 * Pacing and per-call timeouts ride on top of `lml-fetch.ts`'s
 * `defaultLmlLimiter` configured with `BACKFILL_LML_*` env vars — same
 * safety story as the other LML-calling backfills (BS#995).
 *
 * Cooperative pause (BS#735): the orchestrator probes flowsheet for live
 * DJ activity before each batch; the loop yields when a DJ is actively
 * touching the playout, exactly the window where any incremental p95
 * hit is most user-visible. Disable via
 * `LIVE_ACTIVITY_LOOKBACK_SECONDS=0` for catch-up runs.
 *
 * Deps are injected so tests can drive the orchestrator without a live
 * LML or DB.
 *
 * Sentry span attributes on numeric counters are set at span creation,
 * not via late `setAttribute` (BS#1081 — late `setAttribute` calls index
 * numbers as strings and break sum/avg/p95).
 */

import * as Sentry from '@sentry/node';
import {
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  resolveLiveActivityPauseMs as resolveLiveActivityPauseMsShared,
  buildWaitForQuietPeriod,
  checkLiveActivity as defaultCheckLiveActivity,
  type CheckLiveActivityFn,
} from '@wxyc/database';

import type { Candidate } from './query.js';

export type LoadCandidatesFn = () => Promise<Candidate[]>;

export type LookupFn = (discogsReleaseId: number) => Promise<number | null>;

export type WriteFn = (
  rotationId: number,
  discogsReleaseIdAtRead: number,
  lmlIdentityId: number
) => Promise<{ written: boolean }>;

/**
 * Counter shape mirrors `jobs/rotation-release-id-backfill/orchestrate.ts:30-91`.
 * Same five buckets so downstream dashboards / log-line consumers don't
 * have to differentiate. `resolved_dry` covers DRY_RUN runs; the invariant
 * `scanned == resolved + resolved_dry + unresolved + lml_error + raced`
 * holds with or without DRY_RUN.
 */
export type Totals = {
  scanned: number;
  resolved: number;
  resolved_dry: number;
  unresolved: number;
  lml_error: number;
  raced: number;
};

export type RunResult = { totals: Totals };

const envNonNegativeInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return fallback;
};

export const resolveLiveActivityLookback = (
  raw: string | undefined = process.env.LIVE_ACTIVITY_LOOKBACK_SECONDS
): number => envNonNegativeInt(raw, LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT);

/**
 * BS#2147: unlike `resolveLiveActivityLookback` above (which keeps this
 * file's local warn-and-fallback `envNonNegativeInt` parser), the pause
 * resolver now delegates to the shared floored resolver, which THROWS a
 * named error on a sub-floor value (including `0`) instead of silently
 * falling back to the default. `0` used to sleep for that literal duration
 * between re-probes — a hot loop against RDS, not a disable.
 * `LIVE_ACTIVITY_LOOKBACK_SECONDS=0` remains the sole disable knob.
 */
export const resolveLiveActivityPauseMs = (raw: string | undefined = process.env.LIVE_ACTIVITY_PAUSE_MS): number =>
  resolveLiveActivityPauseMsShared(raw, 'LIVE_ACTIVITY_PAUSE_MS');

export const runBackfill = async (deps: {
  loadCandidates: LoadCandidatesFn;
  lookup: LookupFn;
  write: WriteFn;
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

  // BS#1081: numeric attributes are projected at span creation so they
  // index as numbers (not strings) in Sentry's trace explorer.
  return await Sentry.startSpan(
    {
      name: 'rotation-lml-identity-backfill.run',
      op: 'function',
      attributes: {
        'wxyc.backfill.dry_run': Boolean(deps.dryRun),
        'wxyc.backfill.live_activity_lookback_seconds': liveActivityLookbackSeconds,
        'wxyc.backfill.live_activity_pause_ms': liveActivityPauseMs,
      },
    },
    async () => {
      const candidates = await deps.loadCandidates();

      for (const candidate of candidates) {
        await waitForQuietPeriod();

        totals.scanned += 1;
        let identityId: number | null;
        try {
          identityId = await deps.lookup(candidate.discogs_release_id);
        } catch {
          // The row stays `lml_identity_id IS NULL` so it's picked up on
          // the next daily run when LML's cache is warmer. The job entry
          // wraps the orchestrator's loop in Sentry's run-scope so
          // captureException is unnecessary here at the unit boundary.
          totals.lml_error += 1;
          continue;
        }
        if (identityId !== null) {
          if (deps.dryRun) {
            totals.resolved_dry += 1;
            continue;
          }
          const { written } = await deps.write(candidate.id, candidate.discogs_release_id, identityId);
          if (written) {
            totals.resolved += 1;
          } else {
            // The writer's WHERE clause requires `lml_identity_id IS NULL`
            // AND `discogs_release_id` still matches the value we resolved
            // against. 0 rows updated means either (a) another concurrent
            // backfill (cron + manual) beat us, or (b) rotation-etl
            // cleared the row mid-run after a paste-correction. Surface on
            // a dedicated counter so the dashboard distinguishes write
            // success from "lost the race".
            totals.raced += 1;
          }
        } else {
          totals.unresolved += 1;
        }
      }

      return { totals };
    }
  );
};
