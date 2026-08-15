/**
 * Orchestrator for jobs/uncovered-release-list (BS#1877, ADR 0013's
 * "uncovered-release list handoff").
 *
 * Run shape:
 *   1. Fetch every active rotation row (rotation.ts's COALESCE join).
 *      Guard: zero rows -> throw (an empty active-rotation read is a source
 *      regression, not a healthy "nothing to do" week — rotation is never
 *      genuinely empty in production).
 *   2. Resolve each row to a `CanonicalRelease` (library-canonical
 *      `(artist, album, library_id)`), sequentially — mirrors
 *      `album-critic-reviews-etl/orchestrate.ts`'s per-item `matchItem`
 *      loop, avoiding a burst of concurrent connections against the shared
 *      pool for what is a small (~300-row), infrequent (weekly) job. Guard:
 *      zero resolved -> throw (evaluated regardless of DRY_RUN — a resolver
 *      regression must not hide behind a dry run).
 *   3. Dedup to one row per `library.id` (`rotation.dedupeByLibraryId`) —
 *      tubafrenzy permits multiple active rotation rows per release.
 *   4. Two anti-joins (`antijoin.ts`): drop releases that already have an
 *      `album_critic_reviews` row, and drop releases already recorded in
 *      `uncovered_release_search_markers` (already handed off at least
 *      once — see that table's schema.ts doc comment for why this alone is
 *      the "searched, found nothing" marker, with no live feedback needed
 *      from research-data).
 *   5. DRY_RUN stops here: emits the locked-schema JSON report on stdout
 *      and returns, having made zero writes and zero network calls beyond
 *      the read-only DB queries above.
 *   6. Render the snapshot (`writer.renderSnapshot`) ONCE and write it to
 *      disk (`writer.writeSnapshotFile`) — happens even when the uncovered
 *      set is empty; an empty `uncovered-releases.jsonl` is itself a
 *      meaningful, idempotent "nothing new to search this cycle" snapshot,
 *      not a skipped step (unlike the sibling ETL's `nothing_new` early
 *      return, which has no file to write either way).
 *   7. Publish (`publish.ts`) the SAME rendered content to research-data.
 *      A publish failure (thrown) is caught and counted (`publish_error`),
 *      never aborts the run — the local file already succeeded and is this
 *      run's durable artifact regardless of whether the cross-repo push
 *      landed.
 *   8. Record handoff markers (`markers.recordHandoffs`) ONLY when the
 *      publish actually committed. Marking a release "handed off" before
 *      its row ever reached research-data would permanently drop it from
 *      every future cycle's anti-join without it ever having been searched
 *      — the exact failure mode the "found nothing" marker exists to
 *      prevent, just triggered by a disabled/failed publish instead of a
 *      real empty search. See `markers.ts`'s doc comment.
 *
 * Dependencies are injected so unit tests drive the orchestrator without a
 * network, a DB, or a filesystem; `job.ts` wires the real implementations.
 */
import { renderSnapshot } from './writer.js';
import { dedupeByLibraryId, type RotationRow, type CanonicalRelease } from './rotation.js';
import { filterUncovered } from './antijoin.js';
import { log, captureError } from './logger.js';
import type { PublishOutcome } from './publish.js';

const JOB_NAME = 'uncovered-release-list';

export type FetchActiveRotationFn = () => Promise<RotationRow[]>;
export type ResolveCanonicalFn = (row: RotationRow) => Promise<CanonicalRelease | null>;
export type LoadLibraryIdSetFn = (libraryIds: number[]) => Promise<Set<number>>;
export type WriteSnapshotFn = (content: string, path: string) => Promise<{ path: string }>;
export type RecordHandoffsFn = (libraryIds: number[]) => Promise<number>;
export type PublishFn = (content: string) => Promise<PublishOutcome>;

export interface Totals {
  active_rotation_rows: number;
  resolved: number;
  unresolved_dropped: number;
  deduped: number;
  already_covered: number;
  already_handed_off: number;
  uncovered: number;
  /** Lines written to the snapshot file (== `uncovered` on a real run). */
  written: number;
  published: boolean;
  marked_handed_off: number;
}

const emptyTotals = (): Totals => ({
  active_rotation_rows: 0,
  resolved: 0,
  unresolved_dropped: 0,
  deduped: 0,
  already_covered: 0,
  already_handed_off: 0,
  uncovered: 0,
  written: 0,
  published: false,
  marked_handed_off: 0,
});

export interface RunOptions {
  fetchActiveRotation: FetchActiveRotationFn;
  resolveCanonical: ResolveCanonicalFn;
  loadCovered: LoadLibraryIdSetFn;
  loadHandedOff: LoadLibraryIdSetFn;
  writeSnapshot: WriteSnapshotFn;
  recordHandoffs: RecordHandoffsFn;
  publish: PublishFn;
  outputPath: string;
  /** Resolved from DRY_RUN by job.ts; injectable for tests. */
  dryRun?: boolean;
}

/** Donor-standard DRY_RUN resolver: locked truthy set `true|1`
 *  (case-insensitive); everything else — including `yes` — is false. */
export const resolveDryRun = (raw: string | undefined = process.env.DRY_RUN): boolean => {
  if (raw === undefined) return false;
  const lowered = raw.toLowerCase();
  return lowered === 'true' || lowered === '1';
};

export const runJob = async (opts: RunOptions): Promise<Totals> => {
  const totals = emptyTotals();
  const dryRun = opts.dryRun ?? false;

  log('info', 'started', `${JOB_NAME} starting`, { dry_run: dryRun });

  // 1. Fetch active rotation.
  const rows = await opts.fetchActiveRotation();
  totals.active_rotation_rows = rows.length;

  if (totals.active_rotation_rows === 0) {
    throw new Error('active rotation read returned 0 rows — treating as a source regression, not a healthy empty week');
  }

  // 2. Resolve, sequentially.
  const resolved: (CanonicalRelease | null)[] = [];
  for (const row of rows) {
    resolved.push(await opts.resolveCanonical(row));
  }
  totals.resolved = resolved.filter((release) => release !== null).length;
  totals.unresolved_dropped = rows.length - totals.resolved;

  // Guard: zero resolved. Evaluated regardless of DRY_RUN.
  if (totals.resolved === 0) {
    throw new Error(
      `0 of ${rows.length} active rotation rows resolved to a library.id — ` +
        'treating as a resolver regression, not a successful run'
    );
  }

  // 3. Dedup.
  const deduped = dedupeByLibraryId(resolved);
  totals.deduped = deduped.length;

  // 4. Anti-joins.
  const libraryIds = deduped.map((release) => release.libraryId);
  const covered = await opts.loadCovered(libraryIds);
  const handedOff = await opts.loadHandedOff(libraryIds);
  totals.already_covered = deduped.filter((release) => covered.has(release.libraryId)).length;
  totals.already_handed_off = deduped.filter(
    (release) => !covered.has(release.libraryId) && handedOff.has(release.libraryId)
  ).length;
  const uncovered = filterUncovered(deduped, covered, handedOff);
  totals.uncovered = uncovered.length;

  // 5. DRY_RUN stops here.
  if (dryRun) {
    const report = {
      job: JOB_NAME,
      dry_run: true,
      active_rotation_rows: totals.active_rotation_rows,
      resolved: totals.resolved,
      unresolved_dropped: totals.unresolved_dropped,
      deduped: totals.deduped,
      already_covered: totals.already_covered,
      already_handed_off: totals.already_handed_off,
      uncovered: totals.uncovered,
    };
    process.stdout.write(JSON.stringify(report) + '\n');
    log('info', 'finished', `${JOB_NAME} dry run done (no writes, no network calls)`, { ...totals });
    return totals;
  }

  if (uncovered.length === 0) {
    log('info', 'nothing_new', `${JOB_NAME}: no uncovered releases this cycle`, {
      deduped: totals.deduped,
      already_covered: totals.already_covered,
      already_handed_off: totals.already_handed_off,
    });
  }

  // 6. Render + write once; publish and the local file share this exact string.
  const content = renderSnapshot(uncovered);
  const writeResult = await opts.writeSnapshot(content, opts.outputPath);
  totals.written = uncovered.length;
  log('info', 'wrote_snapshot', `${JOB_NAME}: wrote ${totals.written} row(s)`, { path: writeResult.path });

  // 7. Publish, isolated.
  let publishOutcome: PublishOutcome;
  try {
    publishOutcome = await opts.publish(content);
  } catch (error) {
    log('warn', 'publish_error', `${JOB_NAME}: publish failed`, { error_message: (error as Error).message });
    captureError(error, 'publish_error');
    publishOutcome = { attempted: true, committed: false, reason: (error as Error).message };
  }
  totals.published = publishOutcome.committed;

  // 8. Mark handoffs ONLY on a real commit.
  if (publishOutcome.committed) {
    totals.marked_handed_off = await opts.recordHandoffs(uncovered.map((release) => release.libraryId));
  } else {
    log(
      'info',
      'handoff_not_marked',
      `${JOB_NAME}: publish did not commit (${publishOutcome.reason ?? 'unknown'}); ` +
        'search markers NOT written so these releases remain eligible next run',
      { reason: publishOutcome.reason }
    );
  }

  log('info', 'finished', `${JOB_NAME} done`, { ...totals });
  return totals;
};
