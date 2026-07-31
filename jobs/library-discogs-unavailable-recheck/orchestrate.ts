/**
 * Orchestrator for jobs/library-discogs-unavailable-recheck (BS#1283 / epic
 * #1280 sub-issue 3).
 *
 * Iterates `library` rows the music director flagged `discogs_unavailable`,
 * force-asks LML for a fresh Discogs match (bypassing the runtime BS#1293
 * gate), and applies a 0.95 confidence floor before writing anything back —
 * see `writer.ts` for the transactional match writer and the sticky-
 * false-match rationale for its missing IS-NULL guard.
 *
 * Two classes of flagged release need different recovery behavior:
 * audience-segment releases (never on Discogs — permanent skip is correct)
 * and embargoed promos (eventually clear Discogs — the recheck exists to
 * catch that). The 0.95 floor is deliberately *stricter* than the runtime
 * lookup path's own confidence bands so a flagged audience-segment release
 * doesn't get the same false-fuzzy-match re-found and auto-unflagged every
 * day, fighting the MD forever (the "Natanya adversarial loop" the parent
 * issue's self-review caught).
 *
 * Deps are injected so tests can drive the orchestrator without a live LML
 * or DB — mirrors `jobs/rotation-release-id-backfill/orchestrate.ts`.
 */

/** The confidence floor a match must clear before `writeMatch` runs. See the module doc above for why this is stricter than the runtime lookup path's bands. */
export const CONFIDENCE_FLOOR = 0.95;

export type Candidate = {
  id: number;
  artist_name: string;
  album_title: string;
};

export type LoadCandidatesFn = () => Promise<Candidate[]>;

/**
 * Outcome of one forced LML lookup. The 0.95 floor is NOT applied here —
 * `lml-fetch.ts` reports the raw match (or `no_match`) and `runRecheck`
 * below applies the floor, per the parent issue's file layout ("orchestrate.ts
 * — glue + the 0.95 threshold check").
 */
export type LookupOutcome = { kind: 'match'; releaseId: number; confidence: number } | { kind: 'no_match' };

export type LookupFn = (artist: string, album: string) => Promise<LookupOutcome>;

export type WriteMatchFn = (
  libraryId: number,
  releaseId: number
) => Promise<{ written: boolean; rotationRowsUpdated: number }>;

export type StampFn = (libraryId: number) => Promise<{ written: boolean }>;

export type RecordLowConfidenceFn = (params: {
  libraryId: number;
  artistName: string;
  albumTitle: string;
  confidence: number;
}) => void;

export type Totals = {
  scanned: number;
  matched: number;
  low_confidence: number;
  no_match: number;
  lml_error: number;
  db_error: number;
  raced: number;
};

export type RunResult = { totals: Totals };

export const runRecheck = async (deps: {
  loadCandidates: LoadCandidatesFn;
  lookup: LookupFn;
  writeMatch: WriteMatchFn;
  stamp: StampFn;
  recordLowConfidence: RecordLowConfidenceFn;
}): Promise<RunResult> => {
  const totals: Totals = {
    scanned: 0,
    matched: 0,
    low_confidence: 0,
    no_match: 0,
    lml_error: 0,
    db_error: 0,
    raced: 0,
  };

  const candidates = await deps.loadCandidates();
  for (const candidate of candidates) {
    totals.scanned += 1;

    let outcome: LookupOutcome;
    try {
      outcome = await deps.lookup(candidate.artist_name, candidate.album_title);
    } catch {
      // Row stays unstamped (`last_discogs_recheck_at` untouched), so it's
      // picked up again on the next day's run rather than being stamped
      // behind the 7-day recheck window for a merely-transient LML failure.
      totals.lml_error += 1;
      continue;
    }

    if (outcome.kind === 'no_match') {
      try {
        const { written } = await deps.stamp(candidate.id);
        if (written) totals.no_match += 1;
        else totals.raced += 1;
      } catch {
        // Isolate a transient DB failure to this row instead of aborting the
        // batch. The row stays unstamped and is retried the next run.
        totals.db_error += 1;
      }
      continue;
    }

    if (outcome.confidence < CONFIDENCE_FLOOR) {
      // MD wrongly flagged an album that's actually on Discogs — surface it
      // in Sentry without auto-changing state (the Natanya adversarial-loop
      // fix: never write on a sub-floor match).
      deps.recordLowConfidence({
        libraryId: candidate.id,
        artistName: candidate.artist_name,
        albumTitle: candidate.album_title,
        confidence: outcome.confidence,
      });
      try {
        const { written } = await deps.stamp(candidate.id);
        if (written) totals.low_confidence += 1;
        else totals.raced += 1;
      } catch {
        totals.db_error += 1;
      }
      continue;
    }

    try {
      const { written } = await deps.writeMatch(candidate.id, outcome.releaseId);
      if (written) totals.matched += 1;
      else totals.raced += 1;
    } catch {
      // Isolate a transient DB failure (or a failed transaction) to this
      // row; the row stays unstamped and is retried the next run.
      totals.db_error += 1;
    }
  }

  return { totals };
};
