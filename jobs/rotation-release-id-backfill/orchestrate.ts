/**
 * Orchestrator for jobs/rotation-release-id-backfill (BS#1029).
 *
 * Iterates active rotation rows (`kill_date IS NULL OR > CURRENT_DATE`) with
 * NULL `discogs_release_id`, asks LML to resolve `(artist_name, album_title)`
 * to a Discogs release id, and writes the result back to BS PG with
 * `discogs_release_id_source = 'lml_offline_backfill'`. One-shot drain;
 * rerun-safe via the `discogs_release_id IS NULL` SELECT predicate.
 *
 * Pacing and per-call timeouts ride on top of `@wxyc/lml-client`'s
 * `defaultLmlLimiter` configured with `BACKFILL_LML_*` env vars — same
 * safety story as `jobs/flowsheet-metadata-backfill` post-BS#995.
 *
 * Deps are injected so tests can drive the orchestrator without a live
 * LML or DB.
 */

export type Candidate = {
  id: number;
  artist_name: string;
  album_title: string;
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

export type LookupFn = (artist: string, album: string) => Promise<LookupOutcome>;

export type WriteFn = (rotationId: number, releaseId: number) => Promise<{ written: boolean }>;

export type Totals = {
  scanned: number;
  resolved: number;
  resolved_dry: number;
  unresolved: number;
  lml_error: number;
  raced: number;
  sentinel_rejected: number;
  trust_rejected: number;
};

export type RunResult = { totals: Totals };

export const runBackfill = async (deps: {
  loadCandidates: LoadCandidatesFn;
  lookup: LookupFn;
  write: WriteFn;
  dryRun?: boolean;
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
  };

  const candidates = await deps.loadCandidates();
  for (const candidate of candidates) {
    totals.scanned += 1;
    let outcome: LookupOutcome;
    try {
      outcome = await deps.lookup(candidate.artist_name, candidate.album_title);
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
      totals.trust_rejected += 1;
      continue;
    }
    if (outcome.kind === 'no_match') {
      totals.unresolved += 1;
      continue;
    }
    const releaseId = outcome.releaseId;
    if (releaseId <= 0) {
      // BS#1429: rotation.discogs_release_id has a CHECK rejecting `0`
      // and negative ids. Pre-empt the constraint trip here so a
      // poisoned LML response (cache pollution, upstream regression)
      // is contained to one candidate counter instead of crashing the
      // whole nightly batch.
      totals.sentinel_rejected += 1;
      continue;
    }
    if (deps.dryRun) {
      totals.resolved_dry += 1;
      continue;
    }
    const { written } = await deps.write(candidate.id, releaseId);
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
