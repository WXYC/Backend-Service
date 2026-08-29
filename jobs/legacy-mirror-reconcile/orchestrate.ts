/**
 * Reconciliation orchestrator (BS#1707).
 *
 * Two DB-durable, ALL-OR-NOTHING sweeps that re-drive tubafrenzy mirror rows
 * whose single `res.finish` attempt was skipped (flag off at go-live, a
 * transient tubafrenzy failure, a mid-show flag flip, or a BS restart
 * mid-request). Both sweeps read the durable NULL-surrogate-key signal
 * straight from Postgres, so they heal regardless of *why* the live attempt
 * was skipped and survive restarts.
 *
 *   Sweep 1 (create shows): `shows.legacy_show_id IS NULL` +
 *     `primary_dj_id IS NOT NULL` + inside [now-WINDOW, now-SETTLE] +
 *     NOT EXISTS any already-mirrored entry (the all-or-nothing guard —
 *     R4 High #1) + EXISTS a substantive (non-boundary-marker) entry
 *     (BS#2314). Creates the tubafrenzy radioShow and persists
 *     `legacy_show_id`. The NOT EXISTS guard is load-bearing: a mid-show
 *     flag-flip show whose `addEntry` fired already has a server-side
 *     auto-resolved tubafrenzy show (`mapEntryToTubafrenzy` omits
 *     `radioShowID` when null), so creating another would duplicate. The
 *     EXISTS-substantive-entry guard is load-bearing too, for a different
 *     reason: `jobs/flowsheet-show-split` writes its repaired shows with
 *     `legacy_show_id = NULL` ON PURPOSE, to keep them outside
 *     `flowsheet-etl`'s `ON CONFLICT (legacy_show_id) DO UPDATE` (see that
 *     job's module docblock). Without this guard, a split segment whose DJ
 *     logged no tracks before the next go-live — its only rows are the
 *     promoted `show_start` / `show_end` boundary markers, both mirrorable
 *     and both `legacy_entry_id IS NULL` — sails past the NOT-EXISTS guard
 *     (nothing is "already mirrored") and gets adopted here, defeating the
 *     split job's NULL. See `SHOW_BOUNDARY_MARKER_TYPES` below for why this
 *     is framed as "no substantive entry" rather than "came from a split".
 *
 *   Sweep 2 (entries + signoff): `shows.legacy_show_id IS NOT NULL` +
 *     inside the window + all-or-nothing (EXISTS a NULL-legacy entry AND
 *     NOT EXISTS a non-NULL-legacy entry). Keyed on `legacy_show_id IS NOT
 *     NULL` (NOT "created this run") so it covers both a show Sweep 1 just
 *     created *and* a show created on a prior run whose entry loop crashed
 *     (mid-run-kill recovery — R3 Medium #2). Drives every NULL-legacy
 *     entry in `play_order ASC` through the same mapper the live path uses,
 *     then signs the show off if finalized.
 *
 * Partially-mirrored shows (some entries mirrored, some NULL) are NOT
 * auto-healed — re-driving would append the early entries AFTER the
 * already-present later rows because tubafrenzy assigns SEQUENCE_WITHIN_SHOW
 * server-side (review High #2). They are detected and reported (structured
 * log + Sentry warning) for manual remediation.
 *
 * A third, read-only arm (BS#2065) rides this job's daily slot: the
 * stale-open-show detector. It reports shows left with `end_time` NULL past a
 * plausible show duration — the residue of a dropped tubafrenzy `show_end`
 * webhook delivery, which since WXYC/wiki#88 Phase 3 nothing repairs. It runs
 * FIRST, before the sweeps' cooperative pause, because it writes nothing and
 * must not be deferred behind a live DJ. It is isolated in its own try/catch
 * (BS#2069) so a failure there — this arm shares the cron slot for retirement
 * convenience, not because it is load-bearing — is logged and captured to
 * Sentry rather than aborting the two sweeps below it, which are this job's
 * actual purpose. See `runStaleOpenShowReport`.
 *
 * All mirror payloads come from `@wxyc/legacy-mirror` so they are
 * byte-identical to the live path (a re-implementation would drift). The
 * orchestrator is dependency-injected via `ReconcilePorts` so the ordering
 * invariants (show-before-entries, all-or-nothing partitioning, signoff
 * scope, flag gate, cooperative pause) are unit-testable with fakes; the
 * real DB data-access + mirror wiring lives in `job.ts`. The concrete
 * data-access implementation and the single `legacy_entry_id` writer live
 * at the bottom of this module.
 */

import { and, asc, eq, exists, gt, isNotNull, isNull, lt, notExists, notInArray, or, sql } from 'drizzle-orm';
import {
  db,
  flowsheet,
  lastLoggedShowEntryOrderBySql,
  shows,
  user,
  type FSEntry,
  type Show,
  type User,
} from '@wxyc/database';

export type LogLevel = 'info' | 'warn' | 'error';

export interface WindowOptions {
  windowHours: number;
  settleMinutes: number;
}

export interface ReconcileOptions extends WindowOptions, StaleOpenShowOptions {
  /**
   * Emit a Sentry warning when `orphan_shows + orphan_entries + partial_shows`
   * exceeds this value. Default 0 → warn whenever the sweep found anything to
   * heal or report, so the accruing condition is visible before a user
   * notices (would have surfaced #1705 proactively).
   */
  alertThreshold: number;
}

/** Selection bounds for the BS#2065 stale-open-show detector. */
export interface StaleOpenShowOptions extends WindowOptions {
  /**
   * Hours a show may sit with `end_time` NULL before it is reported. See
   * `STALE_OPEN_SHOW_HOURS_DEFAULT` in `job.ts` for the derivation from real
   * WXYC show durations.
   */
  staleAfterHours: number;
}

export interface PartialShow {
  show_id: number;
  orphan_entry_count: number;
}

/**
 * A show still holding `end_time IS NULL` long after any plausible show would
 * have ended (BS#2065). `last_entry_type` / `last_entry_at` describe its
 * newest flowsheet row — a `show_end` there means the sign-off marker landed
 * but the paired `shows.end_time` write did not, which is the exact residue a
 * dropped webhook delivery leaves.
 */
export interface StaleOpenShow {
  show_id: number;
  start_time: Date;
  legacy_show_id: number | null;
  last_entry_type: string | null;
  last_entry_at: Date | null;
}

/**
 * Everything the orchestrator touches, injected so the sequencing invariants
 * are unit-testable without a live DB or tubafrenzy. `job.ts` supplies the
 * real implementations; unit tests supply fakes.
 */
export interface ReconcilePorts {
  // -- data reads --
  selectShowsToCreate(o: WindowOptions): Promise<Show[]>;
  selectEntrySweepShows(o: WindowOptions): Promise<Show[]>;
  selectPartialShows(o: WindowOptions): Promise<PartialShow[]>;
  selectDj(djId: string): Promise<User | null>;
  selectOrphanEntries(showId: number): Promise<FSEntry[]>;
  /** BS#2065 detector: in-window shows still open past `staleAfterHours`. */
  selectStaleOpenShows(o: StaleOpenShowOptions): Promise<StaleOpenShow[]>;
  /** BS#2065 detector: count of open shows OLDER than the reporting window. */
  countHistoricalOpenShows(o: WindowOptions): Promise<number>;

  // -- data writes --
  persistLegacyShowId(showId: number, legacyShowId: number): Promise<void>;
  persistLegacyEntryId(entryId: number, legacyEntryId: number): Promise<void>;

  // -- tubafrenzy mirror (from @wxyc/legacy-mirror; byte-identical to live) --
  mirrorCreateShow(body: Record<string, unknown>): Promise<number | null>;
  mirrorCreateEntry(body: Record<string, unknown>): Promise<number | null>;
  mirrorSignoffShow(radioShowId: number, signoffTime: number): Promise<void>;
  mapShowToTubafrenzy(show: Show, dj: User): Record<string, unknown>;
  mapEntryToTubafrenzy(entry: FSEntry, radioShowID: number | null, isRotationMatch: boolean): Record<string, unknown>;
  isActiveRotationMatch(entry: FSEntry): Promise<boolean>;

  // -- control + observability --
  isMirrorEnabledForDj(djId: string | null): Promise<boolean>;
  awaitQuiet(): Promise<void>;
  log(level: LogLevel, step: string, message: string, fields?: Record<string, unknown>): void;
  captureWarning(message: string, step: string, extra?: Record<string, unknown>): void;
  /** Capture an exception to Sentry (BS#2069 detector isolation). */
  captureError(error: unknown, step: string, extra?: Record<string, unknown>): void;
}

export interface ReconcileTotals {
  /** Sweep-1 candidates (shows with no tubafrenzy show yet) = orphan shows. */
  candidate_shows: number;
  shows_created: number;
  show_create_failures: number;
  /** Sweep-2 candidates (all-or-nothing shows with a tubafrenzy show but no mirrored entries). */
  entry_sweep_shows: number;
  orphan_entries_found: number;
  entries_created: number;
  entries_failed: number;
  signoffs: number;
  partial_shows: number;
  skipped_flag_off: number;
  skipped_no_dj: number;
  /** BS#2065: in-window shows reported as stale-open this run. */
  stale_open_shows: number;
  /**
   * BS#2065: open shows older than `windowHours` — the pre-existing residue
   * #1543's final-dump pass repairs, counted (never listed) so the backlog is
   * observable and its shrink after that pass is verifiable. Stays at its
   * zero default whenever `historical_open_shows_count_failed` is true —
   * that flag is what actually distinguishes "counted zero" from "count
   * unknown," whether the count itself threw or was never attempted at all
   * (see that field's own comment, BS#2098 review item 2).
   */
  historical_open_shows: number;
  /**
   * BS#2069 review finding 3 (widened by BS#2098 review item 2): true when
   * the #1543 backlog count is not trustworthy this run — either because
   * `countHistoricalOpenShows` itself threw, or because it was never
   * attempted at all (`selectStaleOpenShows` failed first, so execution
   * never reached the nested try that calls it). Isolated in its own nested
   * try inside `runStaleOpenShowReport` so this strictly-less-important
   * count's failure cannot discard the per-show `stale_open_show` warn lines
   * and aggregate Sentry warning that `selectStaleOpenShows` already earned
   * by succeeding in the same run. Before the BS#2069 fix there was no
   * nested try: a `countHistoricalOpenShows` timeout after a successful
   * `selectStaleOpenShows` fell into the SAME outer catch as a genuine
   * detector failure, discarding real findings — `totals.stale_open_shows`
   * stayed populated on the `finished` line with zero warn lines or Sentry
   * capture behind it. Before the BS#2098 fix, the OUTER catch (reached when
   * `selectStaleOpenShows` itself throws, before the count is ever attempted)
   * left this flag at its `false` default alongside `historical_open_shows`
   * at its `0` default — indistinguishable from a genuine zero count. The
   * outer catch now sets it too, but only when the nested count was never
   * attempted (`runStaleOpenShowReport` tracks that locally), so it does not
   * clobber a count that had already genuinely succeeded before some LATER
   * step in the try body failed (see BS#2098 review item 3).
   */
  historical_open_shows_count_failed: boolean;
  /**
   * BS#2069: true when `selectStaleOpenShows` threw this run (see
   * `historical_open_shows_count_failed` for the narrower `
   * countHistoricalOpenShows` failure, isolated separately since BS#2069
   * review finding 3 so it no longer sets this flag). The exception is
   * caught, logged, and captured to Sentry at the point of failure — this
   * flag exists so the same fact is visible on the "finished" summary line
   * without grepping Sentry, since a detector-only failure deliberately does
   * NOT flip this job's exit code (see `job.ts`, the call site of
   * `runReconcile`).
   */
  stale_open_show_detector_failed: boolean;
}

const emptyTotals = (): ReconcileTotals => ({
  candidate_shows: 0,
  shows_created: 0,
  show_create_failures: 0,
  entry_sweep_shows: 0,
  orphan_entries_found: 0,
  entries_created: 0,
  entries_failed: 0,
  signoffs: 0,
  partial_shows: 0,
  skipped_flag_off: 0,
  skipped_no_dj: 0,
  stale_open_shows: 0,
  historical_open_shows: 0,
  historical_open_shows_count_failed: false,
  stale_open_show_detector_failed: false,
});

/** Milliseconds for a finalized show's tubafrenzy signoff. */
const toEndMs = (endTime: Date): number => new Date(endTime).getTime();

/**
 * Sweep 1 — create the tubafrenzy show for every all-or-nothing candidate,
 * then persist `legacy_show_id`. Entries are deliberately NOT mirrored here:
 * Sweep 2, which re-queries the DB, picks up the just-created show (now
 * `legacy_show_id IS NOT NULL`, still all-or-nothing) and drives its entries.
 */
const runShowCreateSweep = async (
  ports: ReconcilePorts,
  options: ReconcileOptions,
  totals: ReconcileTotals
): Promise<void> => {
  await ports.awaitQuiet();
  const candidates = await ports.selectShowsToCreate(options);
  totals.candidate_shows = candidates.length;

  for (const show of candidates) {
    await ports.awaitQuiet();

    // Defensive: the SQL already filters `primary_dj_id IS NOT NULL`, but the
    // mapper needs a DJ so a null here would be unmirrorable.
    if (show.primary_dj_id == null) {
      totals.skipped_no_dj += 1;
      continue;
    }

    // Per-show flag gate keyed on the show's `primary_dj_id`, mirroring the
    // live per-caller `backend-mirror` gate (R4 Medium #2). A DJ the rollout
    // deliberately excludes is skipped this run, retry-eligible next run.
    if (!(await ports.isMirrorEnabledForDj(show.primary_dj_id))) {
      totals.skipped_flag_off += 1;
      ports.log('info', 'flag_off', `skipping show ${show.id}: backend-mirror flag OFF for its DJ`, {
        show_id: show.id,
        primary_dj_id: show.primary_dj_id,
      });
      continue;
    }

    const dj = await ports.selectDj(show.primary_dj_id);
    if (!dj) {
      totals.skipped_no_dj += 1;
      ports.log('warn', 'no_dj', `skipping show ${show.id}: primary_dj_id has no auth_user row`, {
        show_id: show.id,
        primary_dj_id: show.primary_dj_id,
      });
      continue;
    }

    const legacyShowId = await ports.mirrorCreateShow(ports.mapShowToTubafrenzy(show, dj));
    if (legacyShowId == null) {
      // mirrorCreateShow already retried 5x + logged to Sentry. Leave
      // `legacy_show_id` NULL so the next sweep retries.
      totals.show_create_failures += 1;
      ports.log(
        'warn',
        'show_create_failed',
        `tubafrenzy show creation failed for show ${show.id}; will retry next run`,
        {
          show_id: show.id,
        }
      );
      continue;
    }

    await ports.persistLegacyShowId(show.id, legacyShowId);
    totals.shows_created += 1;
    ports.log('info', 'show_created', `created tubafrenzy show ${legacyShowId} for BS show ${show.id}`, {
      show_id: show.id,
      legacy_show_id: legacyShowId,
    });
  }
};

/**
 * Sweep 2 — for every all-or-nothing show that already has a tubafrenzy show,
 * drive its NULL-legacy entries in `play_order ASC` and, if the show is
 * finalized, sign it off. Idempotent by construction: once a show's entries
 * carry `legacy_entry_id`, the all-or-nothing candidate query drops it.
 */
const runEntrySweep = async (
  ports: ReconcilePorts,
  options: ReconcileOptions,
  totals: ReconcileTotals
): Promise<void> => {
  await ports.awaitQuiet();
  const candidates = await ports.selectEntrySweepShows(options);
  totals.entry_sweep_shows = candidates.length;

  for (const show of candidates) {
    await ports.awaitQuiet();

    if (show.legacy_show_id == null) continue; // impossible per the query; narrows the type.

    if (!(await ports.isMirrorEnabledForDj(show.primary_dj_id))) {
      totals.skipped_flag_off += 1;
      ports.log('info', 'flag_off', `skipping entries for show ${show.id}: backend-mirror flag OFF for its DJ`, {
        show_id: show.id,
        primary_dj_id: show.primary_dj_id,
      });
      continue;
    }

    const entries = await ports.selectOrphanEntries(show.id);
    totals.orphan_entries_found += entries.length;

    let failuresThisShow = 0;
    for (const entry of entries) {
      // Rotation-match parity (review High #1): a hand-typed rotation track
      // must map to legacy type 2. Compute the same signal the live
      // `addEntry` does before mapping.
      const isRotationMatch = await ports.isActiveRotationMatch(entry);
      const body = ports.mapEntryToTubafrenzy(entry, show.legacy_show_id, isRotationMatch);
      const legacyEntryId = await ports.mirrorCreateEntry(body);
      if (legacyEntryId == null) {
        // STOP on the first failure — don't POST later entries past a gap.
        // Entries drive in `play_order ASC` and tubafrenzy assigns its row
        // SEQUENCE by insertion order, so continuing would append the tail
        // out of order AND manufacture an un-healable middle gap (the show
        // becomes PARTIAL — some entries mirrored, some NULL — and both
        // sweeps skip it forever, routing it to the manual-remediation
        // report). Breaking instead leaves a contiguous NULL suffix: if this
        // was the first entry the show stays fully-unmirrored and Sweep 2
        // re-drives it whole next run; if it was a later entry the remaining
        // NULLs are the ordered tail, appendable in sequence next run.
        failuresThisShow += 1;
        totals.entries_failed += 1;
        break;
      }
      await ports.persistLegacyEntryId(entry.id, legacyEntryId);
      totals.entries_created += 1;
    }

    // Signoff parity (review Medium #3): the live `endShow` posts a separate
    // signoff in addition to the show_end marker. Sign off any finalized
    // all-or-nothing show. `mirrorSignoffShow` is an idempotent POST, and a
    // healed show drops out of the candidate set once its entries exist, so a
    // re-sign can't recur. Defer the signoff when an entry POST failed this
    // run: the show becomes PARTIAL next run and is routed to the report
    // rather than re-driven, so an incomplete mirror shouldn't be marked
    // finalized here.
    if (show.end_time != null) {
      if (failuresThisShow === 0) {
        await ports.mirrorSignoffShow(show.legacy_show_id, toEndMs(show.end_time));
        totals.signoffs += 1;
      } else {
        ports.log(
          'warn',
          'signoff_deferred',
          `deferring signoff for show ${show.id}: ${failuresThisShow} entry POST(s) failed`,
          {
            show_id: show.id,
            entry_failures: failuresThisShow,
          }
        );
      }
    }
  }
};

/**
 * Partial-mirror detection — shows with BOTH a mirrored and an un-mirrored
 * entry. These are excluded from both sweeps (re-driving would append out of
 * order) and are surfaced for manual remediation.
 */
const runPartialReport = async (
  ports: ReconcilePorts,
  options: ReconcileOptions,
  totals: ReconcileTotals
): Promise<void> => {
  const partials = await ports.selectPartialShows(options);
  totals.partial_shows = partials.length;
  for (const p of partials) {
    ports.log(
      'warn',
      'partial_mirror',
      `show ${p.show_id} is partially mirrored (${p.orphan_entry_count} orphan entries); manual remediation required`,
      {
        show_id: p.show_id,
        orphan_entry_count: p.orphan_entry_count,
      }
    );
    ports.captureWarning(
      'legacy-mirror-reconcile: partially-mirrored show requires manual remediation',
      'partial_mirror',
      {
        show_id: p.show_id,
        orphan_entry_count: p.orphan_entry_count,
      }
    );
  }
};

/**
 * How many stale-open shows travel inside the single aggregate Sentry warning.
 *
 * Full per-show detail always goes to the structured log (CloudWatch), which
 * is the durable sink; Sentry carries a bounded sample plus the count. One
 * aggregate event per run rather than `runPartialReport`'s per-show capture
 * because a detector that fires on a backlog would burn error-quota
 * proportional to the backlog — and the WXYC Sentry org has exhausted its
 * org-wide quota before (BS#1291, 2026-06-03), taking every project's error
 * ingest down for days. A detector must not be the thing that does that.
 */
export const STALE_OPEN_SHOW_SENTRY_SAMPLE = 10;

/**
 * Stale-open-show detector (BS#2065) — READ-ONLY, no writes, no mirror calls.
 *
 * A tubafrenzy sign-off arrives as a `show_end` delivery on
 * `/internal/flowsheet-webhook`, which writes the marker row AND stamps
 * `shows.end_time` from the same clock reading (BS#1861 option (a)). Since
 * WXYC/wiki#88 Phase 3 unscheduled `flowsheet-etl`, that stamp is the only
 * thing that ever closes a webhook-originated show: a delivery lost to a
 * tubafrenzy restart, a 500, or a network blip leaves `end_time` NULL with
 * nothing to repair it. `addEntry` and `leaveShow` gate on that column, so the
 * departed DJ's show reads as live until the next show starts.
 *
 * Reported, never repaired here. The accumulated residue is repaired from the
 * final tubafrenzy `mysqldump` under #1543's item 3 (which covers `end_time`
 * alongside `start_time` on these same rows) — the dump is the only
 * authoritative source for these timestamps once MySQL is gone. This arm
 * exists because that pass cannot happen until turndown and the condition
 * accrues in the meantime.
 *
 * Runs before the sweeps and takes no cooperative pause: it writes nothing, so
 * deferring it behind a live DJ would only delay the signal.
 *
 * ISOLATED (BS#2069): the outer body is one try/catch around
 * `selectStaleOpenShows` and the per-show reporting it feeds. This detector
 * rides the same run as the two repair sweeps (BS#1707) purely for scheduling
 * convenience — both mechanisms are retired together at Phase 6a — but it is
 * not the reason the job exists. Before this fix, an unguarded exception here
 * (a statement timeout on the `shows` scan + `flowsheet` anti-join, a
 * transient connection reset) propagated out of `runReconcile`, and `job.ts`'s
 * single outer catch treated that identically to a failed sweep: log 'failed',
 * exit 1, skip everything after. That let a read-only observability arm take
 * down the mirror self-heal it merely shares a cron slot with — the same
 * asymmetry `closeShowFromTerminalShowEndMarker`
 * (`apps/backend/services/flowsheet.service.ts`) already reasons about
 * correctly for its own best-effort backfill. A failure here is logged at
 * 'error' and captured to Sentry with its own fingerprinted step
 * (`stale_open_show_detector`, distinct from `stale_open_show`'s per-show
 * warnings and from the generic `detection` signal below), and recorded on
 * `totals.stale_open_show_detector_failed` — then execution falls through to
 * the sweeps exactly as if the detector had found nothing to report.
 *
 * ISOLATED AGAIN, ONE LEVEL DEEPER (BS#2069 review finding 3):
 * `countHistoricalOpenShows` — the #1543 backlog count, strictly less
 * important than the per-show findings above it — gets its OWN nested
 * try/catch rather than sharing the outer one. Before this fix it sat inside
 * the same try as `selectStaleOpenShows`, so a `countHistoricalOpenShows`
 * timeout AFTER a successful `selectStaleOpenShows` fell into the outer catch
 * and discarded real findings: the per-show warn loop and the aggregate
 * Sentry warning never ran, even though `stale.length` genuinely stale shows
 * had already been found. `totals.stale_open_shows` stayed populated on the
 * `finished` line with zero warn lines or Sentry capture behind it — a
 * partial success silently degraded to a null report. The nested try isolates
 * that count's failure into its own `historical_open_shows_count_failed` flag
 * and its own fingerprinted `stale_open_show_historical_count` Sentry capture,
 * and the per-show warn loop now runs BEFORE the count so it can never be
 * skipped by the count's failure.
 *
 * "COUNTED ZERO" VS. "COUNT UNKNOWN" (BS#2098 review item 2): the nested try
 * above only runs when `selectStaleOpenShows` itself succeeds. Before this
 * fix, when `selectStaleOpenShows` threw, the nested try/catch was never
 * reached at all — `historical_open_shows` stayed at its `0` default AND
 * `historical_open_shows_count_failed` stayed at its `false` default, which
 * together read as "the count genuinely came back zero," identical to the
 * healthy steady state. The `finished`/`detection` log line and any monitor
 * keyed on the flag would then misreport the #1543 backlog as fully drained
 * when it was never measured this run. `historicalCountAttempted` below
 * tracks whether the nested try ran (success OR its own caught failure) so
 * the outer catch can set `historical_open_shows_count_failed = true` for
 * exactly the case the nested try never covers — `selectStaleOpenShows`
 * failing before the count is ever attempted — without clobbering a count
 * that had already genuinely succeeded before a LATER step (e.g. the
 * aggregate `captureWarning` below) throws and lands here too.
 *
 * AN UNGUARDED CAPTURE IN THE OUTER CATCH (BS#2098 review item 3): if
 * `ports.captureWarning` above throws — a Sentry transport error or quota
 * exhaustion, a recurring failure mode in this org (BS#1291) — control lands
 * in this outer catch. Before this fix, `ports.captureError` here was itself
 * unguarded: if it threw for the same underlying reason (the same outage),
 * that second exception would escape this catch block entirely, propagate
 * out of `runStaleOpenShowReport`, and abort the `runShowCreateSweep` /
 * `runEntrySweep` awaits in `runReconcile` below it — reintroducing, one
 * level deeper, exactly the coupling BS#2069 exists to remove. (This path
 * also mislabels what was actually a reporting-transport failure as
 * `stale_open_show_detector_failed` — the detector itself may have
 * succeeded; a real but accepted simplification, not fixed here.) The
 * `ports.captureError` call is now wrapped in its own try/catch: if it also
 * throws, that's logged and swallowed rather than re-thrown. The detector
 * failure is already durable via the `ports.log('error', ...)` call above it
 * (CloudWatch, independent of Sentry's availability), so losing the Sentry
 * capture on top of an already-Sentry-impaired run is an acceptable
 * degradation — taking down the mirror self-heal on top of it is not.
 */
const runStaleOpenShowReport = async (
  ports: ReconcilePorts,
  options: ReconcileOptions,
  totals: ReconcileTotals
): Promise<void> => {
  let historicalCountAttempted = false;
  try {
    const stale = await ports.selectStaleOpenShows(options);
    totals.stale_open_shows = stale.length;

    for (const s of stale) {
      ports.log(
        'warn',
        'stale_open_show',
        `show ${s.show_id} has been open for more than ${options.staleAfterHours}h; likely a dropped tubafrenzy show_end delivery`,
        {
          show_id: s.show_id,
          legacy_show_id: s.legacy_show_id,
          start_time: s.start_time.toISOString(),
          last_entry_type: s.last_entry_type,
          last_entry_at: s.last_entry_at?.toISOString() ?? null,
          stale_after_hours: options.staleAfterHours,
        }
      );
    }

    // See the "ISOLATED AGAIN, ONE LEVEL DEEPER" docblock paragraph above: a
    // failure counting the #1543 backlog must not discard the per-show
    // findings above (already logged) or the aggregate Sentry warning below.
    try {
      totals.historical_open_shows = await ports.countHistoricalOpenShows(options);
    } catch (err) {
      totals.historical_open_shows_count_failed = true;
      const message = err instanceof Error ? err.message : String(err);
      ports.log('warn', 'historical_open_show_count_failed', `historical open-show count failed: ${message}`, {
        error_message: message,
        error_name: err instanceof Error ? err.name : null,
      });
      ports.captureError(err, 'stale_open_show_historical_count', {
        window_hours: options.windowHours,
      });
    } finally {
      // Attempted either way (success or the caught failure just above) —
      // see the "COUNTED ZERO VS COUNT UNKNOWN" docblock paragraph. This is
      // what lets the outer catch below tell "the count never ran" apart
      // from "the count ran and either outcome already happened."
      historicalCountAttempted = true;
    }

    if (stale.length > 0) {
      ports.captureWarning(
        'legacy-mirror-reconcile: show(s) left open past the plausible-duration threshold',
        'stale_open_show',
        {
          stale_open_shows: stale.length,
          stale_after_hours: options.staleAfterHours,
          window_hours: options.windowHours,
          historical_open_shows: totals.historical_open_shows,
          historical_open_shows_count_failed: totals.historical_open_shows_count_failed,
          sample: stale.slice(0, STALE_OPEN_SHOW_SENTRY_SAMPLE).map((s) => ({
            show_id: s.show_id,
            start_time: s.start_time.toISOString(),
            last_entry_type: s.last_entry_type,
            last_entry_at: s.last_entry_at?.toISOString() ?? null,
          })),
        }
      );
    }
  } catch (err) {
    totals.stale_open_show_detector_failed = true;
    // Only when the nested count was never attempted — see the "COUNTED ZERO
    // VS COUNT UNKNOWN" docblock paragraph. A count that already genuinely
    // succeeded (or already recorded its own failure) before some later step
    // threw must not be overwritten here.
    if (!historicalCountAttempted) {
      totals.historical_open_shows_count_failed = true;
    }
    const message = err instanceof Error ? err.message : String(err);
    ports.log('error', 'stale_open_show_detector_failed', `stale-open-show detector failed: ${message}`, {
      error_message: message,
      error_name: err instanceof Error ? err.name : null,
    });
    // See the "AN UNGUARDED CAPTURE IN THE OUTER CATCH" docblock paragraph:
    // this must not be allowed to throw past this point.
    try {
      ports.captureError(err, 'stale_open_show_detector', {
        stale_after_hours: options.staleAfterHours,
        window_hours: options.windowHours,
      });
    } catch (captureErr) {
      const captureMessage = captureErr instanceof Error ? captureErr.message : String(captureErr);
      ports.log(
        'error',
        'stale_open_show_detector_capture_failed',
        `Sentry capture of the detector failure itself failed: ${captureMessage}`,
        {
          error_message: captureMessage,
          error_name: captureErr instanceof Error ? captureErr.name : null,
        }
      );
    }
  }
};

/**
 * Run the full reconciliation: stale-open-show detector → create-show sweep →
 * entry+signoff sweep → partial-mirror report → detection signal. Returns the
 * run totals.
 */
export const runReconcile = async (ports: ReconcilePorts, options: ReconcileOptions): Promise<ReconcileTotals> => {
  const totals = emptyTotals();

  await runStaleOpenShowReport(ports, options, totals);
  await runShowCreateSweep(ports, options, totals);
  await runEntrySweep(ports, options, totals);
  await runPartialReport(ports, options, totals);

  // Detection signal (AC: optional-but-recommended). Always log the counts so
  // the condition is observable; escalate to a Sentry warning above the
  // threshold.
  ports.log('info', 'detection', 'legacy-mirror-reconcile sweep complete', { ...totals });
  const orphanTotal = totals.candidate_shows + totals.orphan_entries_found + totals.partial_shows;
  if (orphanTotal > options.alertThreshold) {
    ports.captureWarning('legacy-mirror-reconcile: orphaned tubafrenzy mirror rows detected', 'detection', {
      orphan_shows: totals.candidate_shows,
      orphan_entries: totals.orphan_entries_found,
      partial_shows: totals.partial_shows,
      shows_created: totals.shows_created,
      entries_created: totals.entries_created,
      signoffs: totals.signoffs,
    });
  }

  return totals;
};

// ── Real DB data-access (wired into ports by job.ts) ───────────────────────
//
// These functions issue the actual drizzle SQL. Their all-or-nothing NOT
// EXISTS predicates and window/settle bounds are the load-bearing selection
// logic; they are exercised end-to-end against a real Postgres by
// `tests/integration/legacy-mirror-reconcile.spec.js` (a hand-written SQL
// twin — keep the two in lockstep). Unit tests drive `runReconcile` with
// fakes instead.

const windowFloor = (windowHours: number) => sql`now() - (interval '1 hour' * ${windowHours})`;
const settleCeiling = (settleMinutes: number) => sql`now() - (interval '1 minute' * ${settleMinutes})`;

/**
 * Flowsheet entry types the live mirror path NEVER assigns a `legacy_entry_id`.
 *
 * `dj_join` / `dj_leave` markers are inserted as side effects of
 * `joinShow` / `endShow` / `leaveShow` (apps/backend/services/flowsheet.service.ts)
 * on the `POST /join` and `POST /end` routes, whose mirror middleware is
 * `flowsheetMirror.startShow` / `.endShow`. Those handlers mirror only the show
 * plus the `show_start` / `show_end` announcement — never these markers
 * (apps/backend/middleware/legacy/flowsheet.mirror.ts). Only `addEntry`
 * (`POST /`) drives an entry through `mirrorCreateEntry`, and join/leave markers
 * are never created that way. They therefore carry `legacy_entry_id IS NULL`
 * permanently.
 *
 * The job must exclude them everywhere it reasons about "an entry that SHOULD
 * have been mirrored but wasn't". Counting them would (a) falsely flag every
 * multi-DJ show as partially-mirrored on every run (it has both a mirrored
 * track and a permanently-NULL marker) and never heal, and (b) drive Sweep 2 to
 * POST them to tubafrenzy as talkset entries the live path never creates,
 * breaking the byte-identical-payload parity this job is built on.
 */
const NON_MIRRORED_MARKER_TYPES = ['dj_join', 'dj_leave'] as const;

/** A NULL-legacy row of a type the live path would actually have mirrored. */
const mirrorableEntryType = notInArray(flowsheet.entry_type, [...NON_MIRRORED_MARKER_TYPES]);

/**
 * Subquery: does show S have any *mirrorable* entry with the given
 * legacy_entry_id nullness? The `mirrorableEntryType` guard excludes the
 * permanently-NULL join/leave markers (see `NON_MIRRORED_MARKER_TYPES`) from
 * both branches, so `nullLegacy=true` means "has a genuinely un-mirrored entry"
 * rather than "has a marker the live path was never going to mirror".
 */
const entryExists = (nullLegacy: boolean) =>
  db
    .select({ one: sql`1` })
    .from(flowsheet)
    .where(
      and(
        eq(flowsheet.show_id, shows.id),
        mirrorableEntryType,
        nullLegacy ? isNull(flowsheet.legacy_entry_id) : isNotNull(flowsheet.legacy_entry_id)
      )
    );

/**
 * `show_start` / `show_end` ARE mirrorable (unlike `dj_join`/`dj_leave` —
 * `NON_MIRRORED_MARKER_TYPES` above), so they don't help `entryExists` tell a
 * show worth creating from one that isn't. But they are still just boundary
 * bookends, never evidence a set happened: `POST /flowsheet/join` writes a
 * `show_start` for a show with zero tracks yet, `endShow` writes a `show_end`
 * for one that never got any, and `jobs/flowsheet-show-split`'s `applySplit`
 * step 4 promotes a segment's `dj_join`/`dj_leave` into exactly this pair
 * (BS#2314) — a segment whose DJ logged nothing before the next go-live ends
 * up with ONLY these two rows, both `legacy_entry_id IS NULL`, so they alone
 * would satisfy `notExists(entryExists(false))` above and get adopted.
 *
 * Deliberately NOT keyed on anything specific to a split-created show (e.g.
 * `legacy_dj_name IS NULL`, or "started right at another show's `end_time`")
 * — every one of those is a shape a normal, never-split show can reproduce,
 * which is exactly the kind of heuristic a future legitimate show could
 * defeat. This asks the question Sweep 1 should ask regardless of how the
 * show came to exist: did a set actually happen? A show whose only
 * mirrorable rows are its own start/end bookends has no set to mirror,
 * split segment or not — see BS#2314 Option 3 for the "not worth minting
 * upstream" framing this codifies.
 */
const SHOW_BOUNDARY_MARKER_TYPES = ['show_start', 'show_end'] as const;

/** A row that is actual DJ content — a track or a talkset/breakpoint/message note — not a boundary marker. */
const substantiveEntryType = notInArray(flowsheet.entry_type, [
  ...NON_MIRRORED_MARKER_TYPES,
  ...SHOW_BOUNDARY_MARKER_TYPES,
]);

/** Subquery: does show S have at least one substantive (non-boundary-marker) entry? */
const hasSubstantiveEntry = db
  .select({ one: sql`1` })
  .from(flowsheet)
  .where(and(eq(flowsheet.show_id, shows.id), substantiveEntryType));

export const selectShowsToCreate = async ({ windowHours, settleMinutes }: WindowOptions): Promise<Show[]> =>
  db
    .select()
    .from(shows)
    .where(
      and(
        isNull(shows.legacy_show_id),
        isNotNull(shows.primary_dj_id),
        lt(shows.start_time, settleCeiling(settleMinutes)),
        gt(shows.start_time, windowFloor(windowHours)),
        notExists(entryExists(false)),
        exists(hasSubstantiveEntry)
      )
    )
    .orderBy(asc(shows.start_time));

export const selectEntrySweepShows = async ({ windowHours, settleMinutes }: WindowOptions): Promise<Show[]> =>
  db
    .select()
    .from(shows)
    .where(
      and(
        isNotNull(shows.legacy_show_id),
        // Same settle bound as Sweep 1: a show still inside the settle window may
        // be mid-live-mirror — its show-create already persisted `legacy_show_id`
        // while a just-added track sits NULL-legacy for the moment before the
        // live path finishes mirroring it. Sweeping then would double-POST that
        // entry. The cooperative pause mitigates but is a heuristic; this bound
        // is deterministic.
        lt(shows.start_time, settleCeiling(settleMinutes)),
        gt(shows.start_time, windowFloor(windowHours)),
        exists(entryExists(true)),
        notExists(entryExists(false))
      )
    )
    .orderBy(asc(shows.start_time));

export const selectPartialShows = async ({ windowHours, settleMinutes }: WindowOptions): Promise<PartialShow[]> =>
  db
    .select({
      show_id: shows.id,
      orphan_entry_count: sql<number>`(SELECT count(*)::int FROM ${flowsheet} WHERE ${flowsheet.show_id} = ${shows.id} AND ${flowsheet.legacy_entry_id} IS NULL AND ${mirrorableEntryType})`,
    })
    .from(shows)
    // Same settle bound as the sweeps: a show still inside the settle window may
    // have one track mirrored and another mid-live-mirror, which looks partial
    // but is transient. Reporting it would raise a false "partial → manual
    // remediation" Sentry warning; the bound lets the live path finish first.
    .where(
      and(
        lt(shows.start_time, settleCeiling(settleMinutes)),
        gt(shows.start_time, windowFloor(windowHours)),
        exists(entryExists(true)),
        exists(entryExists(false))
      )
    );

// ── BS#2065 stale-open-show detector SQL ────────────────────────────────────

const staleCeiling = (staleAfterHours: number) => sql`now() - (interval '1 hour' * ${staleAfterHours})`;

/**
 * The show `flowsheet_service.getLatestShow()` returns — `ORDER BY id DESC
 * LIMIT 1` over the whole table, which is what `addEntry` / `leaveShow` /
 * `joinShow` treat as "the current show". Kept as `max(id)` rather than
 * `max(start_time)` deliberately — it must track `getLatestShow`'s ordering,
 * not a plausible substitute for it.
 *
 * Holding this id is now only a CONDITIONAL exclusion (BS#2068), not an
 * absolute one — see `selectStaleOpenShows`'s second bullet. Excluding it
 * unconditionally, as this bound originally did, meant the detector could
 * never report the exact state a dropped tubafrenzy `show_end` delivery
 * leaves a show in: `max(id)`, sign-off marker present, `end_time` still
 * NULL. `addEntry` / `leaveShow` / `joinShow` gate on `getLatestShow()`, so
 * that state is precisely when "who's on air" reads wrong — the harm the
 * detector exists to surface, per #2065's own residual-harm list.
 */
const latestShowId = sql`(SELECT max(s2.id) FROM ${shows} s2)`;

/**
 * Last row LOGGED for the outer `shows` row (BS#2118 site 8).
 *
 * `id DESC`, via the shared `lastLoggedShowEntryOrderBySql` helper
 * (@wxyc/database) that also serves `flowsheet_service`'s
 * `isLatestEntryShowEnd` (site 5) and `closeShowFromTerminalShowEndMarker`
 * (site 7). The rationale for the key — why not `play_order`, why not
 * `add_time` even though the page reads moved, and what accepting `id DESC`
 * exposes — lives once in that helper's doc comment. This comment previously
 * asserted "the serial PK is an unambiguous 'newest'", which was the exact
 * claim BS#2118 disproved.
 *
 * WHAT THAT ACCEPTANCE COSTS THIS DETECTOR SPECIFICALLY: a historical insert
 * (backfill, gap import, repair) into a still-open show takes the highest id
 * and flips `newestEntryType` away from `'show_end'` — disabling the
 * sign-off escape hatch in `selectStaleOpenShows` below, so this job can no
 * longer report the exact state it exists to catch (a dropped `show_end`
 * delivery with `end_time` still NULL). `newestEntryAt` degrades the same
 * way: it reports the import's row rather than the show's real last
 * activity, and that is the value an operator reads as `last_entry_at`.
 *
 * Not reached by #2119's April cohort — those 18 shows are closed, and this
 * detector selects only `end_time IS NULL`. Reachable by any import landing
 * while a show is open; the #1543 last-write re-run is the concrete
 * candidate, and the operator constraint is to run it outside a live window.
 *
 * Written with an explicit `fe` alias and an explicitly table-qualified outer
 * reference (`${shows}.id`) rather than the bare `${flowsheet.col}` /
 * `${shows.id}` interpolations `selectPartialShows` uses. Those render
 * FULLY-QUALIFIED inside a `where(...)` but BARE inside a `select({...})`
 * projection — so `WHERE ${flowsheet.show_id} = ${shows.id}` in a projection
 * subquery renders `WHERE "show_id" = "id"`, and Postgres resolves BOTH names
 * against the subquery's own `flowsheet` scope: a silent
 * `flowsheet.show_id = flowsheet.id` self-correlation that returns arbitrary
 * rows instead of the show's own. Aliasing the inner table and qualifying the
 * outer column makes the correlation unambiguous in either context.
 */
const newestEntryType = sql<string | null>`(SELECT fe.entry_type FROM ${flowsheet} fe
    WHERE fe.show_id = ${shows}.id ORDER BY ${lastLoggedShowEntryOrderBySql('fe')} LIMIT 1)`;

const newestEntryAt = sql<Date | null>`(SELECT fe.add_time FROM ${flowsheet} fe
    WHERE fe.show_id = ${shows}.id ORDER BY ${lastLoggedShowEntryOrderBySql('fe')} LIMIT 1)`;

/**
 * Detector selection: `end_time IS NULL`, no activity since the cutoff, inside
 * the recurring window, and — unless its own sign-off marker already landed —
 * never the current show.
 *
 * Three independent bounds, each load-bearing:
 *   - `start_time < now() - staleAfterHours` — the plausible-duration
 *     threshold (derivation in `job.ts`).
 *   - NOT EXISTS a flowsheet row newer than the same cutoff — a genuinely-live
 *     marathon show is still logging tracks, so it is excluded on activity
 *     even in the impossible case that it is somehow not the latest show id.
 *   - `id <> max(id) OR newestEntryType = 'show_end'` (BS#2068) — excludes the
 *     current show, UNLESS its newest flowsheet entry is a `show_end` marker.
 *     A show whose latest row is a sign-off marker cannot be genuinely live —
 *     no DJ is on it (BS#1861 option (b), which `joinShow`'s opportunistic
 *     `closeShowFromTerminalShowEndMarker` backfill already relies on) — so
 *     gating the id exclusion on that marker preserves the "genuinely-active
 *     show never reported" acceptance criterion (the activity bound above
 *     still excludes it independently) while letting the detector see the one
 *     state it exists to catch: a dropped `show_end` webhook leaves a show
 *     BOTH `max(id)` AND signed off, and that combination must be reportable,
 *     not permanently vetoed. Before this fix the bound was the unconditional
 *     `id <> max(id)`, which vetoed exactly that combination.
 *
 * And an outer bound: `start_time > now() - windowHours`. Older open shows are
 * the historical-remediation class — 2,813 rows as of 2026-08-09, all >30 days
 * old, repaired by #1543's final-dump pass — deliberately out of scope for a
 * recurring report, exactly as the two mirror sweeps scope theirs. They are
 * counted by `countHistoricalOpenShows` instead of listed.
 *
 * The in-window band (`windowHours - staleAfterHours`, 36h at the defaults)
 * being wider than this job's 24h period is NOT by itself a guarantee that a
 * show which goes stale is seen by at least one run — that was the pre-fix
 * docblock's claim, and it did not survive the unconditional id bound vetoing
 * every run across the whole band whenever the show never stopped being
 * `max(id)` (it silently aged into the historical cohort instead; see
 * BS#2068's concrete timeline). With the marker-conditioned bound above, a
 * show whose sign-off marker landed IS reportable regardless of whether a
 * newer show has since started, so the band-width arithmetic does its
 * intended job for that case. A show whose `show_end` marker itself never
 * arrived is a different, out-of-scope failure — indistinguishable here from
 * a quiet live show — and is left to the #1543 dump-based repair, same as
 * before this fix.
 *
 * The `id <> max(id) OR newestEntryType = 'show_end'` bullet above MUST be
 * built with drizzle's `or()` helper, not a raw `sql` fragment containing a
 * literal ` OR `. `and(...)` wraps its own children in exactly one pair of
 * parentheses — it does not parenthesize each child individually — so a raw
 * `sql\`(...) OR (...)\`` passed as one of `and`'s arguments renders as a bare
 * disjunct INSIDE that single AND-group's parens, not as a parenthesized
 * sub-term. Since SQL's `AND` binds tighter than `OR`, the whole WHERE clause
 * then parses as `(bound1 AND bound2 AND bound3 AND bound4 AND idBoundArm1)
 * OR showEndArm2` — the `show_end` arm stands alone as a full-table predicate
 * with none of the other bounds applied. That shipped bug (caught in review,
 * fixed before merge) would have reported essentially every show that ever
 * ended: no `end_time IS NULL` filter, no threshold, no window, over a seq
 * scan with correlated `LIMIT 1` subqueries per row. `or()` renders its own
 * group in its own parens nested correctly inside `and()`'s — see
 * `apps/enrichment-worker/precheck.ts`'s `hasLoadBearingAlbumMetadata` for the
 * established precedent (`and(..., or(isNotNull(a), isNotNull(b)), ...)`).
 * The `buildStaleOpenShowsQuery`/rendered-SQL parenthesization unit test in
 * `tests/unit/jobs/legacy-mirror-reconcile/stale-open-shows-sql.test.ts` pins
 * this against the real query builder so a future regression here fails a
 * unit test, not just a live-Postgres integration run.
 */
export const buildStaleOpenShowsQuery = ({ windowHours, staleAfterHours }: StaleOpenShowOptions) =>
  db
    .select({
      show_id: shows.id,
      start_time: shows.start_time,
      legacy_show_id: shows.legacy_show_id,
      last_entry_type: newestEntryType,
      last_entry_at: newestEntryAt,
    })
    .from(shows)
    .where(
      and(
        isNull(shows.end_time),
        lt(shows.start_time, staleCeiling(staleAfterHours)),
        gt(shows.start_time, windowFloor(windowHours)),
        sql`NOT EXISTS (SELECT 1 FROM ${flowsheet} WHERE ${flowsheet.show_id} = ${shows.id} AND ${flowsheet.add_time} >= ${staleCeiling(staleAfterHours)})`,
        or(sql`${shows.id} IS DISTINCT FROM ${latestShowId}`, eq(newestEntryType, 'show_end'))
      )
    )
    .orderBy(asc(shows.start_time));

export const selectStaleOpenShows = async (o: StaleOpenShowOptions): Promise<StaleOpenShow[]> =>
  buildStaleOpenShowsQuery(o);

/**
 * Count of open shows older than the reporting window — the #1543 repair
 * cohort. Count-only on purpose: this job does not repair them and must not
 * imply it will, and listing thousands of rows every night would bury the
 * handful that are actionable now.
 */
export const countHistoricalOpenShows = async ({ windowHours }: WindowOptions): Promise<number> => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(shows)
    .where(and(isNull(shows.end_time), lt(shows.start_time, windowFloor(windowHours))));
  return row?.n ?? 0;
};

export const selectDj = async (djId: string): Promise<User | null> => {
  const rows = await db.select().from(user).where(eq(user.id, djId)).limit(1);
  return rows[0] ?? null;
};

export const selectOrphanEntries = async (showId: number): Promise<FSEntry[]> =>
  db
    .select()
    .from(flowsheet)
    // Exclude the permanently-NULL join/leave markers (`mirrorableEntryType`):
    // Sweep 2 must POST only the entries the live path would have mirrored, or
    // the reconciled tubafrenzy show diverges from the live-path shape.
    .where(and(eq(flowsheet.show_id, showId), isNull(flowsheet.legacy_entry_id), mirrorableEntryType))
    .orderBy(asc(flowsheet.play_order));

export const persistLegacyShowId = async (showId: number, legacyShowId: number): Promise<void> => {
  // `AND legacy_show_id IS NULL` matches the live path's idempotency convention:
  // never overwrite a surrogate key another writer (a concurrent live mirror, a
  // prior run) already set. A second racer's UPDATE then no-ops instead of
  // repointing the show to a duplicate tubafrenzy row.
  await db
    .update(shows)
    .set({ legacy_show_id: legacyShowId })
    .where(and(eq(shows.id, showId), isNull(shows.legacy_show_id)));
};

/**
 * Persist the tubafrenzy surrogate key on a freshly-mirrored flowsheet row.
 *
 * This is a sibling of use #2 of the `flowsheet.legacy_entry_id` three-use
 * invariant (BS#908 / Epic H#882): the write records the just-allocated
 * tubafrenzy entry ID AFTER a successful `mirrorCreateEntry`, exactly like the
 * live mirror path (`apps/backend/middleware/legacy/flowsheet.mirror.ts`). It
 * never populates a placeholder for a non-tubafrenzy row, so the loop-guard
 * read (`legacy_entry_id != null` ⇒ "came from tubafrenzy, don't mirror
 * back") stays sound. The three uses and their constraints are documented on
 * the column at `shared/database/src/schema.ts`; CI enforces this write site
 * is registered at `scripts/check-legacy-entry-id-writes.mjs`.
 */
export const persistLegacyEntryId = async (entryId: number, legacyEntryId: number): Promise<void> => {
  // `AND legacy_entry_id IS NULL` mirrors the live path's loop guard: an entry
  // whose surrogate key is already set (a concurrent live mirror, a prior run)
  // is never repointed, so a racing writer's UPDATE no-ops.
  await db
    .update(flowsheet)
    .set({ legacy_entry_id: legacyEntryId })
    .where(and(eq(flowsheet.id, entryId), isNull(flowsheet.legacy_entry_id)));
};
