/**
 * Step 1 of jobs/concerts-artist-resolver's four-step run (BS#1760, parent
 * #1618, On Tour epic #1588): sync the `concert_performers` junction
 * (role='support') from `concerts.supporting_artists_raw`.
 *
 * Split into a pure per-concert diff (`diffConcertPerformers`) and a
 * dep-injected orchestrator loop (`runSync`), mirroring orchestrate.ts's
 * `runResolver` shape — the DB-touching `loadSyncCandidates`/`applyDiff`
 * implementations live in sync-db.ts and are wired in by job.ts.
 *
 * Sync policy (locked decisions from the BS#1760 issue):
 *   - UPSERT one row per array element, idempotent on
 *     `(concert_id, role, raw_name)` — a name already present as an
 *     ACTIVE row is a no-op (steady state).
 *   - Array-shrink → soft-tombstone: an ACTIVE row whose name fell out of
 *     the array gets `removed_at` set. Never hard-deleted — a tombstoned
 *     row retains `discogs_artist_id` + `artist_resolve_attempted_at` so
 *     a later re-bill doesn't re-spend the Phase-D LML budget re-asking a
 *     name that was already resolved once.
 *   - Reappearance → un-tombstone: a TOMBSTONED row whose name is back in
 *     the array gets `removed_at` cleared. Mirrors the concerts writer's
 *     own both-directions `removed_at` policy (triangle-shows-etl/
 *     writer.ts).
 *   - A row that's both absent from the array AND already tombstoned, or
 *     both present AND already active, produces no diff — this is what
 *     makes a re-run against unchanged input idempotent (`runSync` never
 *     calls `applyDiff` for an empty diff).
 *
 * Candidate scope (both the concert-level SELECT this loop iterates AND
 * the existing-junction-row read behind it) is upcoming, non-tombstoned
 * concerts — `concerts.removed_at IS NULL AND starts_on >= todayEastern`
 * — enforced independently in sync-db.ts's `loadSyncCandidates`, per the
 * migration 0128 note that the `concert_performers` row alone doesn't
 * carry its parent concert's tombstone (the `ON DELETE CASCADE` only
 * fires on a hard delete, which rarely happens).
 */

import { safeNotifyError } from './error-sink.js';

/** One `concert_performers` row (role='support') as read for the diff. */
export type ExistingPerformerRow = {
  raw_name: string;
  /** Non-null means tombstoned. Only presence-vs-absence is inspected —
   *  the diff never reasons about how long ago the tombstone landed. */
  removed_at: string | Date | null;
};

/** One upcoming, non-tombstoned concert's sync inputs. */
export type SyncCandidate = {
  concert_id: number;
  supporting_artists_raw: string[];
  /** Every existing role='support' `concert_performers` row for this
   *  concert — active AND tombstoned, since the diff needs to see both
   *  to decide insert vs. untombstone vs. tombstone vs. no-op. */
  existing: ExistingPerformerRow[];
};

export type SyncDiff = {
  /** Names with no existing row at all — brand new. */
  to_insert: string[];
  /** Names with an existing TOMBSTONED row that reappeared in the array. */
  to_untombstone: string[];
  /** Names with an existing ACTIVE row that dropped out of the array. */
  to_tombstone: string[];
};

/**
 * Pure per-concert diff. No DB, no I/O — everything needed to decide the
 * three write buckets is already on `candidate`.
 *
 * `to_insert` is defensively deduped (a `Set` over the raw array) even
 * though `mergeSupportingArtists` (triangle-shows-etl/map.ts) already
 * dedupes the stored array insensitively before it ever reaches this
 * job — belt-and-suspenders against a pathological or legacy-scraped row
 * whose array carries an exact-string duplicate.
 */
export const diffConcertPerformers = (candidate: SyncCandidate): SyncDiff => {
  const arraySet = new Set(candidate.supporting_artists_raw);
  const existingNames = new Set(candidate.existing.map((row) => row.raw_name));

  const to_insert = [...new Set(candidate.supporting_artists_raw)].filter((name) => !existingNames.has(name));

  const to_untombstone: string[] = [];
  const to_tombstone: string[] = [];
  for (const row of candidate.existing) {
    const stillBilled = arraySet.has(row.raw_name);
    const isTombstoned = row.removed_at !== null;
    if (stillBilled && isTombstoned) {
      to_untombstone.push(row.raw_name);
    } else if (!stillBilled && !isTombstoned) {
      to_tombstone.push(row.raw_name);
    }
    // stillBilled && !isTombstoned (steady-state active) and
    // !stillBilled && isTombstoned (steady-state tombstoned) both need no
    // action — the idempotent no-op cases.
  }

  return { to_insert, to_untombstone, to_tombstone };
};

const isEmptyDiff = (diff: SyncDiff): boolean =>
  diff.to_insert.length === 0 && diff.to_untombstone.length === 0 && diff.to_tombstone.length === 0;

export type LoadSyncCandidatesFn = () => Promise<SyncCandidate[]>;
export type ApplySyncDiffOutcome = { inserted: number; untombstoned: number; tombstoned: number };
export type ApplySyncDiffFn = (concertId: number, diff: SyncDiff) => Promise<ApplySyncDiffOutcome>;
export type OnSyncErrorFn = (candidate: SyncCandidate, error: unknown) => void | Promise<void>;

export type SyncTotals = {
  concerts_scanned: number;
  /** Concerts whose diff was non-empty and applyDiff was invoked (may be
   *  less than concerts_scanned even ignoring errors — a scanned concert
   *  in steady state produces an empty diff and is never applied). */
  concerts_changed: number;
  inserted: number;
  untombstoned: number;
  tombstoned: number;
  error: number;
};

const emptyTotals = (): SyncTotals => ({
  concerts_scanned: 0,
  concerts_changed: 0,
  inserted: 0,
  untombstoned: 0,
  tombstoned: 0,
  error: 0,
});

export type RunSyncResult = { totals: SyncTotals };

const SINK_FAILURE_PREFIX = 'concerts-artist-resolver.sync';

/**
 * Dep-injected orchestrator loop for the sync step. `loadCandidates`
 * returns every upcoming, non-tombstoned concert's current support array
 * plus its existing junction rows; for each, `diffConcertPerformers`
 * computes the three write buckets and `applyDiff` persists them.
 *
 * A concert with an empty diff is skipped entirely — `applyDiff` is only
 * ever called for a concert that actually needs a write. This is what
 * makes a re-run against unchanged input a true no-op (no writes issued,
 * not just writes that happen to affect zero rows).
 *
 * Per-candidate errors are caught and counted, never abort the batch —
 * symmetric with `runResolver`'s per-row error containment.
 */
export const runSync = async (deps: {
  loadCandidates: LoadSyncCandidatesFn;
  applyDiff: ApplySyncDiffFn;
  onError?: OnSyncErrorFn;
}): Promise<RunSyncResult> => {
  const totals = emptyTotals();
  const onError: OnSyncErrorFn = deps.onError ?? (() => {});

  const candidates = await deps.loadCandidates();
  for (const candidate of candidates) {
    totals.concerts_scanned += 1;

    const diff = diffConcertPerformers(candidate);
    if (isEmptyDiff(diff)) {
      continue;
    }

    try {
      const outcome = await deps.applyDiff(candidate.concert_id, diff);
      totals.concerts_changed += 1;
      totals.inserted += outcome.inserted;
      totals.untombstoned += outcome.untombstoned;
      totals.tombstoned += outcome.tombstoned;
    } catch (error) {
      totals.error += 1;
      await safeNotifyError(onError, candidate, error, SINK_FAILURE_PREFIX);
    }
  }

  return { totals };
};
