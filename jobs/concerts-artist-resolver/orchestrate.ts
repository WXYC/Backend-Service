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
   * The raw venue-scraped artist name. The DB column is `NOT NULL` and
   * the production SELECT additionally filters `IS NOT NULL`, so this
   * branch is unreachable in prod today. The type intentionally permits
   * NULL as a forward-compat seam: a future editorial-submission source
   * (#1347's note on multi-source ingest) may relax the constraint, and
   * the orchestrator's `null_raw_skipped` counter is the tripwire that
   * tells operators when that change reaches the resolver.
   */
  headlining_artist_raw: string | null;
};

/**
 * Per-row callback the orchestrator uses to surface a failure (resolver
 * OR writer) with concert-level context. Production wires this to a log
 * + Sentry capture in `job.ts`; tests pass a no-op spy so the loop
 * semantics (counter increment, `continue`) can be exercised without
 * observability coupling. Reports the concert id and the underlying
 * error message so dashboards triaging a `resolver.error` spike can
 * pivot from the counter to the failing rows in one click.
 *
 * The return type permits `Promise<void>` so async sinks (Slack, an
 * external logger) compose cleanly — the orchestrator awaits the call
 * and swallows any throw/rejection so a misbehaving sink can never
 * abort the batch.
 */
export type OnRowErrorFn = (candidate: Candidate, error: unknown) => void | Promise<void>;

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

/**
 * Invoke an `onError` sink without letting it abort the batch. `await`
 * accepts both `void` and `Promise<void>` returns; a sync throw or an
 * async rejection from the sink is caught and never re-raised, so a
 * misbehaving sink can never break the loop. The counter is the durable
 * record of failures, not the sink — but we still write a single stderr
 * line on sink failure so a broken observability path (Sentry transport
 * down, log throws EPIPE, etc.) is at least visible in container logs
 * instead of silently disappearing.
 */
const safeNotifyError = async (onError: OnRowErrorFn, candidate: Candidate, error: unknown): Promise<void> => {
  try {
    await onError(candidate, error);
  } catch (sinkError) {
    const sinkMessage = sinkError instanceof Error ? sinkError.message : String(sinkError);
    try {
      process.stderr.write(
        `concerts-artist-resolver: onError sink failed for concert ${candidate.id}: ${sinkMessage}\n`
      );
    } catch {
      /* even stderr is gone — there is nothing else we can do */
    }
  }
};

export const runResolver = async (deps: {
  loadCandidates: LoadCandidatesFn;
  resolve: ResolveFn;
  write: WriteFn;
  onError?: OnRowErrorFn;
}): Promise<RunResult> => {
  const totals = emptyTotals();
  const onError: OnRowErrorFn = deps.onError ?? (() => {});

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
    } catch (error) {
      // Transient resolver failure (e.g. PG statement timeout). Bump
      // the counter FIRST so totals stay accurate even if the sink
      // misbehaves, then notify observers. The row stays NULL; the
      // next cron run picks it up via the IS-NULL gate.
      totals.error += 1;
      await safeNotifyError(onError, candidate, error);
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
            // The writer's WHERE clause guards on
            // `headlining_artist_id IS NULL`. A 0-row UPDATE means a
            // concurrent run beat us (the cron is rerun-safe, but two
            // ETL pods could both pick the same row up mid-scan).
            totals.raced += 1;
          }
        } catch (error) {
          // Symmetric with the resolver-error path: a transient write
          // failure (PG outage, FK race against a parallel artist
          // delete, etc.) must not terminate the loop and leave the
          // remaining candidates unprocessed. The row stays NULL and
          // the next cron run drains it.
          totals.error += 1;
          await safeNotifyError(onError, candidate, error);
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
