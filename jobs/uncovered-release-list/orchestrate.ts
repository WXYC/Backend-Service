/**
 * Orchestrator for jobs/uncovered-release-list (BS#1877, ADR 0013's
 * "uncovered-release list handoff", widened by the "rotation ∪ recently
 * played" amendment).
 *
 * Run shape:
 *   1. Fetch every active rotation row (rotation.ts's COALESCE join).
 *      Guard: zero rows -> throw in steady state (an empty active-rotation
 *      read is a source regression, not a healthy "nothing to do" week —
 *      rotation is never genuinely empty in production). Under `--backfill`
 *      this demotes to a loud log + Sentry capture and the run continues on
 *      the play arm alone — rotation is ~300 of ~37,721 backfill candidates,
 *      and a rotation-source regression mid-drain must not abort a run
 *      holding tens of thousands of valid play-arm candidates.
 *   2. Resolve each rotation row to a `CanonicalRelease` (library-canonical
 *      `(artist, album, library_id)`), sequentially — mirrors
 *      `album-critic-reviews-etl/orchestrate.ts`'s per-item `matchItem`
 *      loop, avoiding a burst of concurrent connections against the shared
 *      pool for what is a small (~300-row), infrequent (weekly) job. Guard:
 *      zero resolved (when there WERE rotation rows to resolve) -> throw in
 *      steady state, evaluated regardless of DRY_RUN — a resolver
 *      regression must not hide behind a dry run. Demotes under
 *      `--backfill` the same way as guard 1.
 *   3. Fetch the play-arm candidates via the single injected
 *      `fetchPlayCandidates` — already-canonical `CanonicalRelease[]`, no
 *      resolve step needed (see plays.ts). This orchestrator never sees
 *      which arm (`fetchRecentPlays` vs `fetchAllPlayedAlbums`) is wired in;
 *      `job.ts` picks based on `--backfill`. Guard: zero play rows -> NOT a
 *      throw — loud structured log + unconditional Sentry capture, exit
 *      stays 0. An empty 30-day `flowsheet` window in prod is not an
 *      expected common case (it means the station stopped logging plays or
 *      the query broke), so this escalates rather than staying silent; but
 *      it must not abort a run that may still hold valid rotation
 *      candidates. This also keeps the local `DRY_RUN=true` recipe working
 *      against the dev seed, which has no `flowsheet` rows.
 *   4. Concatenate resolved rotation releases first, then play-arm
 *      releases — an album in both keeps its rotation-arm entry once
 *      dedup runs (same `library_id`, same canonical pair, so semantically
 *      free), but this pins determinism and keeps rotation at the head of
 *      the cap ordering.
 *   5. Dedup to one row per `library.id` (`rotation.dedupeByLibraryId`) —
 *      tubafrenzy permits multiple active rotation rows per release, and a
 *      release can independently surface via both arms.
 *   6. Two anti-joins (`antijoin.ts`): drop releases that already have an
 *      `album_critic_reviews` row, and drop releases already recorded in
 *      `uncovered_release_search_markers` (already handed off at least
 *      once — see that table's schema.ts doc comment for why this alone is
 *      the "searched, found nothing" marker, with no live feedback needed
 *      from research-data).
 *   7. Cap: truncate the uncovered set to `maxReleasesPerRun`
 *      (`UNCOVERED_MAX_RELEASES_PER_RUN`), immediately after the anti-join
 *      and BEFORE the DRY_RUN branch — after that branch, `capped_out`
 *      would always report 0 in exactly the mode an operator uses to check
 *      whether the cap is firing. One cap knob, one cap position, in both
 *      modes; no separate backfill limit, no SQL `LIMIT` (see plays.ts and
 *      the README's "Cap placement" / backfill-pacing sections for why a
 *      SQL `LIMIT` would silently stall the drain).
 *   8. DRY_RUN stops here: emits the locked-schema JSON report on stdout
 *      and returns, having made zero writes and no network calls beyond
 *      the read-only DB queries above — plus a Sentry capture if a guard
 *      escalated (the guards deliberately carry no DRY_RUN exemption).
 *   9. Render the snapshot (`writer.renderSnapshot`) ONCE from the CAPPED
 *      list and write it to disk (`writer.writeSnapshotFile`) — happens
 *      even when the capped set is empty; an empty LOCAL
 *      `uncovered-releases.jsonl` is itself a meaningful, idempotent
 *      "nothing new to search this cycle" artifact, not a skipped step.
 *      The empty case is local-only: step 10 declines to PUBLISH it.
 *   10. Publish (`publish.ts`) the SAME rendered content to research-data,
 *      UNLESS the capped set is empty — publishing is a whole-file replace
 *      of one fixed path, so an empty publish hands off nothing while
 *      destroying a previous snapshot whose releases are already
 *      permanently marked.
 *      A publish failure (thrown) is caught and counted (`publish_error`),
 *      never aborts the run — the local file already succeeded and is this
 *      run's durable artifact regardless of whether the cross-repo push
 *      landed.
 *   11. Record handoff markers (`markers.recordHandoffs`) for the CAPPED
 *      list ONLY when the publish actually committed. Marking a release
 *      "handed off" before its row ever reached research-data would
 *      permanently drop it from every future cycle's anti-join without it
 *      ever having been searched — the exact failure mode the "found
 *      nothing" marker exists to prevent. Using the capped (not uncovered)
 *      list here specifically prevents permanently stranding the truncated
 *      tail: the file on disk, the published snapshot, and the marker rows
 *      always describe the identical release set.
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
export type FetchPlayCandidatesFn = () => Promise<CanonicalRelease[]>;
export type LoadLibraryIdSetFn = (libraryIds: number[]) => Promise<Set<number>>;
export type WriteSnapshotFn = (content: string, path: string) => Promise<{ path: string }>;
export type RecordHandoffsFn = (libraryIds: number[]) => Promise<number>;
export type PublishFn = (content: string) => Promise<PublishOutcome>;

export interface Totals {
  active_rotation_rows: number;
  resolved: number;
  unresolved_dropped: number;
  /** Play-arm rows (already canonical) — new. */
  recent_play_rows: number;
  /** `resolved + recent_play_rows`, post-concat/pre-dedup — new. */
  candidate_rows: number;
  deduped: number;
  already_covered: number;
  already_handed_off: number;
  /** Post-anti-join, pre-cap. */
  uncovered: number;
  /** `uncovered - capped`, computed at the cap site — new. */
  capped_out: number;
  /** Lines written to the snapshot file (== the capped length on a real run). */
  written: number;
  published: boolean;
  marked_handed_off: number;
}

const emptyTotals = (): Totals => ({
  active_rotation_rows: 0,
  resolved: 0,
  unresolved_dropped: 0,
  recent_play_rows: 0,
  candidate_rows: 0,
  deduped: 0,
  already_covered: 0,
  already_handed_off: 0,
  uncovered: 0,
  capped_out: 0,
  written: 0,
  published: false,
  marked_handed_off: 0,
});

export interface RunOptions {
  fetchActiveRotation: FetchActiveRotationFn;
  resolveCanonical: ResolveCanonicalFn;
  fetchPlayCandidates: FetchPlayCandidatesFn;
  loadCovered: LoadLibraryIdSetFn;
  loadHandedOff: LoadLibraryIdSetFn;
  writeSnapshot: WriteSnapshotFn;
  recordHandoffs: RecordHandoffsFn;
  publish: PublishFn;
  outputPath: string;
  /** `UNCOVERED_MAX_RELEASES_PER_RUN` — post-anti-join cap, both modes. */
  maxReleasesPerRun: number;
  /** Resolved from DRY_RUN by job.ts; injectable for tests. */
  dryRun?: boolean;
  /** True under `--backfill`; demotes the two rotation-lane guards (zero
   *  active rotation, zero resolved) from a hard throw to the same
   *  log+Sentry escalation the zero-plays guard uses, since a backfill run
   *  must be able to proceed on the play arm alone. Defaults false. */
  backfill?: boolean;
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
  const backfill = opts.backfill ?? false;

  log('info', 'started', `${JOB_NAME} starting`, { dry_run: dryRun, backfill });

  // 1. Fetch active rotation.
  const rows = await opts.fetchActiveRotation();
  totals.active_rotation_rows = rows.length;

  if (totals.active_rotation_rows === 0) {
    const message = 'active rotation read returned 0 rows';
    if (backfill) {
      log(
        'error',
        'rotation_empty_backfill',
        `${JOB_NAME}: ${message} under --backfill — rotation is ~300 of ~37,721 backfill candidates; ` +
          'continuing the drain on the play arm alone',
        {}
      );
      captureError(new Error(`${JOB_NAME}: ${message} under --backfill`), 'rotation_empty_backfill');
    } else {
      throw new Error(`${message} — treating as a source regression, not a healthy empty week`);
    }
  }

  // 2. Resolve, sequentially.
  const resolved: (CanonicalRelease | null)[] = [];
  for (const row of rows) {
    resolved.push(await opts.resolveCanonical(row));
  }
  totals.resolved = resolved.filter((release) => release !== null).length;
  totals.unresolved_dropped = rows.length - totals.resolved;

  // Guard: zero resolved, only meaningful when there were rotation rows to
  // resolve in the first place (rows.length === 0 is guard 1's condition,
  // already handled above — checking it again here would double-escalate
  // the identical root cause under --backfill). Evaluated regardless of
  // DRY_RUN.
  if (rows.length > 0 && totals.resolved === 0) {
    const message = `0 of ${rows.length} active rotation rows resolved to a library.id`;
    if (backfill) {
      log(
        'error',
        'resolve_empty_backfill',
        `${JOB_NAME}: ${message} under --backfill — continuing the drain on the play arm alone`,
        {}
      );
      captureError(new Error(`${JOB_NAME}: ${message} under --backfill`), 'resolve_empty_backfill');
    } else {
      throw new Error(`${message} — treating as a resolver regression, not a successful run`);
    }
  }

  // 3. Fetch play-arm candidates. Mode-blind: job.ts already selected
  // fetchRecentPlays or fetchAllPlayedAlbums.
  const recentPlays = await opts.fetchPlayCandidates();
  totals.recent_play_rows = recentPlays.length;

  // Guard: zero play rows. NOT a throw — loud log + unconditional Sentry
  // capture, exit stays 0. See the module docstring's step 3 for why this
  // lane never throws (mirrors the local DRY_RUN dev-seed recipe).
  if (totals.recent_play_rows === 0) {
    const message = `${JOB_NAME}: play-arm candidate fetch returned 0 rows`;
    log('error', 'plays_empty', message, {});
    captureError(new Error(message), 'plays_empty');
  }

  // 4. Concat: rotation-resolved releases first, then play-arm releases.
  const resolvedReleases = resolved.filter((release): release is CanonicalRelease => release !== null);
  const candidates = [...resolvedReleases, ...recentPlays];
  totals.candidate_rows = candidates.length;

  // 5. Dedup.
  const deduped = dedupeByLibraryId(candidates);
  totals.deduped = deduped.length;

  // 6. Anti-joins.
  const libraryIds = deduped.map((release) => release.libraryId);
  const covered = await opts.loadCovered(libraryIds);
  const handedOff = await opts.loadHandedOff(libraryIds);
  totals.already_covered = deduped.filter((release) => covered.has(release.libraryId)).length;
  totals.already_handed_off = deduped.filter(
    (release) => !covered.has(release.libraryId) && handedOff.has(release.libraryId)
  ).length;
  const uncovered = filterUncovered(deduped, covered, handedOff);
  totals.uncovered = uncovered.length;

  // 7. Cap — post-anti-join, pre-DRY_RUN. See the module docstring's step 7
  // and the README's "Cap placement" section for why this exact position.
  const capped = uncovered.slice(0, opts.maxReleasesPerRun);
  totals.capped_out = uncovered.length - capped.length;
  if (totals.capped_out > 0) {
    log('warn', 'capped', `${JOB_NAME}: cap fired — ${totals.capped_out} uncovered release(s) held back this run`, {
      uncovered: totals.uncovered,
      max_releases_per_run: opts.maxReleasesPerRun,
      capped_out: totals.capped_out,
    });
  }

  // 8. DRY_RUN stops here.
  if (dryRun) {
    const report = {
      job: JOB_NAME,
      dry_run: true,
      backfill,
      active_rotation_rows: totals.active_rotation_rows,
      resolved: totals.resolved,
      unresolved_dropped: totals.unresolved_dropped,
      recent_play_rows: totals.recent_play_rows,
      candidate_rows: totals.candidate_rows,
      deduped: totals.deduped,
      already_covered: totals.already_covered,
      already_handed_off: totals.already_handed_off,
      uncovered: totals.uncovered,
      capped_out: totals.capped_out,
    };
    process.stdout.write(JSON.stringify(report) + '\n');
    log('info', 'finished', `${JOB_NAME} dry run done (no writes)`, { ...totals });
    return totals;
  }

  if (capped.length === 0) {
    log('info', 'nothing_new', `${JOB_NAME}: no uncovered releases this cycle`, {
      deduped: totals.deduped,
      already_covered: totals.already_covered,
      already_handed_off: totals.already_handed_off,
    });
  }

  // 9. Render + write once, from the CAPPED list; publish and the local
  // file share this exact string.
  const content = renderSnapshot(capped);
  const writeResult = await opts.writeSnapshot(content, opts.outputPath);
  totals.written = capped.length;
  log('info', 'wrote_snapshot', `${JOB_NAME}: wrote ${totals.written} row(s)`, { path: writeResult.path });

  // 10. Publish, isolated — but NEVER publish an empty snapshot.
  //
  // Publishing is a whole-file replace of one fixed path, and markers are
  // publish-once. An empty publish therefore buys nothing (there is no
  // release to hand off) while destroying the previous snapshot at
  // research-data HEAD — whose releases are already permanently marked. If
  // the consumer had not yet read that snapshot, those releases become
  // marked-but-never-searched with no recovery path: exactly the failure
  // the publish-gated marker design exists to prevent, and the same hazard
  // the README's "Backfill pacing" section bounds from the other direction.
  // Holding the previous file costs at most a redundant re-read by the
  // consumer, which is harmless (its releases are already marked, so they
  // cannot be re-offered).
  //
  // Keyed on `capped`, not `uncovered` — `capped` is what was rendered,
  // written, and would be published, so it is the set this decision is about.
  //
  // The LOCAL write above still happens unconditionally — an empty local
  // `uncovered-releases.jsonl` is a meaningful "nothing new this cycle"
  // artifact, and nothing downstream reads it.
  let publishOutcome: PublishOutcome;
  if (capped.length === 0) {
    publishOutcome = { attempted: false, committed: false, reason: 'empty snapshot: nothing to hand off' };
    log('info', 'publish_skipped_empty', `${JOB_NAME}: nothing to publish; leaving the previous snapshot in place`);
  } else {
    try {
      publishOutcome = await opts.publish(content);
    } catch (error) {
      log('warn', 'publish_error', `${JOB_NAME}: publish failed`, { error_message: (error as Error).message });
      captureError(error, 'publish_error');
      publishOutcome = { attempted: true, committed: false, reason: (error as Error).message };
    }
  }
  totals.published = publishOutcome.committed;

  // 11. Mark handoffs for the CAPPED list ONLY on a real commit.
  if (publishOutcome.committed) {
    totals.marked_handed_off = await opts.recordHandoffs(capped.map((release) => release.libraryId));
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
