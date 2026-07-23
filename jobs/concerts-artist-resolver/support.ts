/**
 * Step 3 of jobs/concerts-artist-resolver's four-step run (BS#1760, parent
 * #1618, On Tour epic #1588): the support-act resolve arm.
 *
 * BESPOKE loop — deliberately NOT `runResolver` from orchestrate.ts. That
 * loop and its `writeArtistId` writer are headliner-shaped: `Candidate`
 * carries `headlining_artist_raw` and the writer hardcodes
 * `concerts.headlining_artist_id`. Reusing either here would mean either
 * coercing `concert_performers` rows into a headliner-shaped type or
 * threading a column/table parameter through code that has no other
 * caller — both worse than a small, honestly-separate loop. The ONLY
 * thing reused from the headliner arm is the pure `resolveArtistId(raw) →
 * outcome` function itself (imported by job.ts and passed in here as
 * `resolve`) plus its `ResolveFn`/`ResolveOutcome` TYPE contract, which is
 * candidate-agnostic by construction — nothing about `(raw: string) =>
 * Promise<ResolveOutcome>` mentions concerts or headliners.
 *
 * Shape mirrors `runResolver` closely on purpose (same
 * loadCandidates → resolve → write flow, same per-row error containment
 * via the shared `safeNotifyError` in error-sink.ts) — the two loops
 * SHOULD look similar, they just aren't allowed to be the same function
 * per the BS#1760 issue's explicit constraint. One deliberate shape
 * difference: there is no `null_raw_skipped` branch here.
 * `concert_performers.raw_name` is `NOT NULL` (unlike
 * `concerts.headlining_artist_raw`, which the `Candidate` type in
 * orchestrate.ts permits as a forward-compat seam), so a NULL raw name
 * can't reach this loop at all.
 *
 * No attempt-at marker: per the BS#1760 issue and docs/migrations.md's
 * "Attempt-at markers" section, `concert_performers.
 * artist_resolve_attempted_at` binds ONLY the future Phase-D LML arm.
 * This Phase-B pure-SQL arm stamps nothing on ambiguous/unmatched, same
 * as today's headliner SQL arm.
 */

import type { ResolveFn, ResolveOutcome } from './orchestrate.js';
import { safeNotifyError } from './error-sink.js';

/** One unresolved `concert_performers` row (role='support') as read for
 *  the resolve arm — see support-db.ts's `loadSupportCandidates` for the
 *  full candidate predicate (unresolved, active, tribute-guarded, joined
 *  to an upcoming non-tombstoned concert). */
export type SupportCandidate = { id: number; raw_name: string };

export type LoadSupportCandidatesFn = () => Promise<SupportCandidate[]>;
export type WriteSupportFn = (performerId: number, artistId: number) => Promise<{ written: boolean }>;
export type OnSupportRowErrorFn = (candidate: SupportCandidate, error: unknown) => void | Promise<void>;

export type SupportTotals = {
  scanned: number;
  resolved: number;
  resolved_strict: number;
  resolved_alias: number;
  ambiguous: number;
  unmatched: number;
  error: number;
  raced: number;
};

const emptyTotals = (): SupportTotals => ({
  scanned: 0,
  resolved: 0,
  resolved_strict: 0,
  resolved_alias: 0,
  ambiguous: 0,
  unmatched: 0,
  error: 0,
  raced: 0,
});

export type RunSupportResolverResult = { totals: SupportTotals };

const SINK_FAILURE_PREFIX = 'concerts-artist-resolver.support';

export const runSupportResolver = async (deps: {
  loadCandidates: LoadSupportCandidatesFn;
  resolve: ResolveFn;
  write: WriteSupportFn;
  onError?: OnSupportRowErrorFn;
}): Promise<RunSupportResolverResult> => {
  const totals = emptyTotals();
  const onError: OnSupportRowErrorFn = deps.onError ?? (() => {});

  const candidates = await deps.loadCandidates();
  for (const candidate of candidates) {
    totals.scanned += 1;

    let outcome: ResolveOutcome;
    try {
      outcome = await deps.resolve(candidate.raw_name);
    } catch (error) {
      // Transient resolver failure. The row stays NULL, no marker either
      // way (Phase-B carries none) — the next cron run picks it up via
      // the same `artist_id IS NULL` gate.
      totals.error += 1;
      await safeNotifyError(onError, candidate, error, SINK_FAILURE_PREFIX);
      continue;
    }

    switch (outcome.kind) {
      case 'strict':
      case 'alias': {
        try {
          const { written } = await deps.write(candidate.id, outcome.artist_id);
          if (written) {
            totals.resolved += 1;
            if (outcome.kind === 'strict') {
              totals.resolved_strict += 1;
            } else {
              totals.resolved_alias += 1;
            }
          } else {
            // The writer's WHERE clause guards on `artist_id IS NULL`
            // (fill-NULLs-only). A 0-row UPDATE means a concurrent run
            // beat us to this row.
            totals.raced += 1;
          }
        } catch (error) {
          totals.error += 1;
          await safeNotifyError(onError, candidate, error, SINK_FAILURE_PREFIX);
        }
        break;
      }
      case 'ambiguous':
        totals.ambiguous += 1;
        break;
      case 'unmatched':
        totals.unmatched += 1;
        break;
    }
  }

  return { totals };
};
