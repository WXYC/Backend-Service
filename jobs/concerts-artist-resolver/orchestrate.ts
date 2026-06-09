/**
 * Orchestrator for jobs/concerts-artist-resolver (BS#1372).
 *
 * Iterates `concerts` rows where `headlining_artist_id IS NULL` and
 * `headlining_artist_raw IS NOT NULL`, asks the resolver to map the raw
 * name to a single canonical `artists.id`, and writes the FK back when
 * the resolver returns an unambiguous match. NULL stays NULL on every
 * ambiguous / unmatched / errored row — the substrate (#1347) treats
 * NULL as the documented steady state.
 *
 * The resolver is the SQL JOIN, not this loop. It runs strict-first
 * against the functional index on `artists`, falls through to the
 * `artist_search_alias` join only when strict returns zero matches, and
 * collapses multi-`artist_id` outcomes to `ambiguous`. The orchestrator
 * trusts the resolver's `kind` and never re-classifies — that's how the
 * unit tests stay deterministic and how the strict-wins rule stays
 * enforced in one place.
 *
 * Idempotency: the SELECT predicate gates a rerun-safe drain. Already-
 * resolved rows are never re-examined; the resolver is write-once-trust-
 * forever. Counters are reported at the run-end log line and emitted as
 * Sentry span attributes by the entrypoint.
 *
 * Dep-injected so unit tests can drive the orchestrator without PG —
 * see `tests/unit/jobs/concerts-artist-resolver/orchestrate.test.ts`.
 */

export type Candidate = {
  id: number;
  /**
   * The raw venue-scraped artist name. The production SELECT filters
   * NULL out, but the type permits NULL so the orchestrator can stay
   * defensive (counted as `null_raw_skipped`, the resolver is never
   * called).
   */
  headlining_artist_raw: string | null;
};

export type ResolveOutcome =
  | { kind: 'strict'; artist_id: number }
  | { kind: 'alias'; artist_id: number }
  | { kind: 'ambiguous' }
  | { kind: 'unmatched' };

export type LoadCandidatesFn = () => Promise<Candidate[]>;
export type ResolveFn = (raw: string) => Promise<ResolveOutcome>;
export type WriteFn = (concertId: number, artistId: number) => Promise<{ written: boolean }>;

export type Totals = {
  scanned: number;
  resolved: number;
  resolved_strict: number;
  resolved_alias: number;
  ambiguous: number;
  unmatched: number;
  null_raw_skipped: number;
  error: number;
  raced: number;
};

export type RunResult = { totals: Totals };

const emptyTotals = (): Totals => ({
  scanned: 0,
  resolved: 0,
  resolved_strict: 0,
  resolved_alias: 0,
  ambiguous: 0,
  unmatched: 0,
  null_raw_skipped: 0,
  error: 0,
  raced: 0,
});

export const runResolver = async (deps: {
  loadCandidates: LoadCandidatesFn;
  resolve: ResolveFn;
  write: WriteFn;
}): Promise<RunResult> => {
  const totals = emptyTotals();

  const candidates = await deps.loadCandidates();
  for (const candidate of candidates) {
    totals.scanned += 1;

    if (candidate.headlining_artist_raw === null) {
      totals.null_raw_skipped += 1;
      continue;
    }

    let outcome: ResolveOutcome;
    try {
      outcome = await deps.resolve(candidate.headlining_artist_raw);
    } catch {
      // Transient resolver failure (e.g. PG statement timeout). The row
      // stays `headlining_artist_id IS NULL`, so the next run picks it
      // up again. The entrypoint wraps the loop in Sentry's run-scope
      // so captureError isn't needed at this unit boundary.
      totals.error += 1;
      continue;
    }

    switch (outcome.kind) {
      case 'strict':
      case 'alias': {
        const { written } = await deps.write(candidate.id, outcome.artist_id);
        if (written) {
          totals.resolved += 1;
          if (outcome.kind === 'strict') {
            totals.resolved_strict += 1;
          } else {
            totals.resolved_alias += 1;
          }
        } else {
          // The writer's WHERE clause guards on
          // `headlining_artist_id IS NULL`. A 0-row UPDATE means a
          // concurrent run beat us (the cron is rerun-safe, but two
          // ETL pods could both pick the same row up mid-scan).
          totals.raced += 1;
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
