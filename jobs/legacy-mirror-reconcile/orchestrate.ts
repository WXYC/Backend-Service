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
 *     R4 High #1). Creates the tubafrenzy radioShow and persists
 *     `legacy_show_id`. The NOT EXISTS guard is load-bearing: a mid-show
 *     flag-flip show whose `addEntry` fired already has a server-side
 *     auto-resolved tubafrenzy show (`mapEntryToTubafrenzy` omits
 *     `radioShowID` when null), so creating another would duplicate.
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
 * All mirror payloads come from `@wxyc/legacy-mirror` so they are
 * byte-identical to the live path (a re-implementation would drift). The
 * orchestrator is dependency-injected via `ReconcilePorts` so the ordering
 * invariants (show-before-entries, all-or-nothing partitioning, signoff
 * scope, flag gate, cooperative pause) are unit-testable with fakes; the
 * real DB data-access + mirror wiring lives in `job.ts`. The concrete
 * data-access implementation and the single `legacy_entry_id` writer live
 * at the bottom of this module.
 */

import { and, asc, eq, exists, gt, isNotNull, isNull, lt, notExists, notInArray, sql } from 'drizzle-orm';
import { db, flowsheet, shows, user, type FSEntry, type Show, type User } from '@wxyc/database';

export type LogLevel = 'info' | 'warn' | 'error';

export interface WindowOptions {
  windowHours: number;
  settleMinutes: number;
}

export interface ReconcileOptions extends WindowOptions {
  /**
   * Emit a Sentry warning when `orphan_shows + orphan_entries + partial_shows`
   * exceeds this value. Default 0 → warn whenever the sweep found anything to
   * heal or report, so the accruing condition is visible before a user
   * notices (would have surfaced #1705 proactively).
   */
  alertThreshold: number;
}

export interface PartialShow {
  show_id: number;
  orphan_entry_count: number;
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
        failuresThisShow += 1;
        totals.entries_failed += 1;
        continue;
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
 * Run the full reconciliation: create-show sweep → entry+signoff sweep →
 * partial-mirror report → detection signal. Returns the run totals.
 */
export const runReconcile = async (ports: ReconcilePorts, options: ReconcileOptions): Promise<ReconcileTotals> => {
  const totals = emptyTotals();

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
        notExists(entryExists(false))
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
