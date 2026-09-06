/**
 * The 30-day auto-downgrade write path (BS#2364 / station-signup-review
 * plan). Self-signed accounts left unreviewed for 30 days or more drop
 * `dj` -> `member`.
 *
 * This is the only automatic privilege downgrade in the job fleet, so it is
 * split into a PLAN phase and an APPLY phase rather than one pass:
 * `planDowngrades` decides, per account, what will happen and why, without
 * writing anything; `orchestrate.ts` puts the digest describing those
 * decisions on the wire; `applyDowngrades` then performs the writes. The
 * digest is therefore never a claim about a write that already happened
 * behind the operator's back.
 *
 * Writes `auth_member.role` directly via `@wxyc/database`, exactly as the
 * issue specifies. This is safe for this ONE role pair because
 * `grantsAdminFlag` (`shared/authentication/src/admin-flag-sync.ts`) is
 * `normalizeRole(role) === 'stationManager'` -- neither `dj` nor `member`
 * ever touches the `auth_user.role='admin'` flag, so no better-auth hook
 * needs to fire for this write to be complete. Reusing this bare-write
 * pattern for a different role pair (anything touching stationManager)
 * would desync the admin flag silently -- see WXYC/Backend-Service#2171 for
 * the standing `auth_user.role` / `auth_member.role` drift this relies on
 * not making worse.
 *
 * Never deletes, never bans, never writes `auth_user.role` -- reversible
 * with one roster edit back to `dj`, and that re-promotion now sticks
 * (see `selfSignupDowngradedAt` below). The ONLY `auth_user` column this
 * module writes is `self_signup_downgraded_at`.
 *
 * ## Why the marker exists
 *
 * The digest cohort is `self_signup_at IS NOT NULL AND
 * self_signup_reviewed_at IS NULL` (`query.ts`), and the downgrade
 * deliberately does NOT stamp `self_signup_reviewed_at` -- that column is
 * the manager's review queue, shared verbatim with dj-site's roster
 * predicate, so stamping it would empty the queue and make the account
 * permanently invisible. A downgraded account therefore never leaves the
 * cohort. Without a separate terminal marker it satisfied the 30-day cutoff
 * and the `WHERE role = 'dj'` guard again the moment a manager re-promoted
 * it, and the next morning's run demoted it again -- forever. The
 * "reversible with one roster edit" promise, inverted into a trap.
 *
 * `auth_user.self_signup_downgraded_at` (migration 0161) closes that: the
 * downgrade pass adds `AND self_signup_downgraded_at IS NULL`, and stamps it
 * in the same transaction as the role flip. The actuator fires at most once
 * per account; the digest keeps nagging daily until a human reviews.
 */
import { and, eq, exists, isNull, or } from 'drizzle-orm';
import { db, member, show_djs, shows, user } from '@wxyc/database';
import type { PendingSignupRow } from './query.js';

/**
 * Why 30 days: it exceeds any holiday break, so the downgrade cannot fire
 * mid-break and strand a working DJ. It only ever catches accounts nobody
 * reviewed *after* the break ended.
 */
export const DOWNGRADE_AFTER_DAYS = 30;

const DOWNGRADE_AFTER_MS = DOWNGRADE_AFTER_DAYS * 24 * 60 * 60 * 1000;

/** `true` once `now` is at or past `selfSignupAt + DOWNGRADE_AFTER_DAYS` (inclusive of the boundary instant). */
export const isPastDowngradeCutoff = (selfSignupAt: Date, now: Date): boolean =>
  now.getTime() - selfSignupAt.getTime() >= DOWNGRADE_AFTER_MS;

/**
 * Kill switch, **defaulting OFF**. Strict `=== 'true'` -- an accidental
 * `=1`/`TRUE`/`yes` must not arm an automatic privilege downgrade. Same
 * convention as `DONATE_ENABLED`, `DIGITAL_ARCHIVE_STREAMING_ENABLED` and
 * `FLOWSHEET_TAKEOVER_ENABLED` (`apps/backend/config/envFlag.ts`'s
 * `createEnvFlagConfig`), hand-rolled here rather than imported because a
 * `jobs/*` workspace does not depend on `apps/backend`.
 *
 * Read fresh on every call rather than memoized: cron jobs run as
 * `docker run --env-file .env`, one process per run, so flipping the value
 * in the host's `.env` takes effect on the next run with no restart.
 *
 * OFF still produces a full digest -- an overdue account is named and
 * reported as `downgrade-disabled`, so turning the actuator off makes the
 * station LESS informed about nothing.
 */
export const isDowngradeEnabled = (): boolean => process.env.STATION_SIGNUP_DOWNGRADE_ENABLED === 'true';

type DbClient = typeof db;

/**
 * What this run decided about one pending account. Every pending row gets
 * exactly one decision, so the digest renders a per-row outcome rather than
 * inferring one from `days >= 30`, which conflated "a prior run downgraded
 * this" with "a manager changed the role" and became an outright false
 * statement under the kill switch or the on-air guard.
 *
 * - `pending` — inside the 30-day window; the digest shows a countdown.
 * - `downgraded` — this run will flip (or flipped) it `dj` -> `member`.
 * - `already-downgraded` — a prior run flipped it; `downgradedAt` is the
 *   stored `self_signup_downgraded_at`. Never re-fires.
 * - `deferred-on-air` — overdue, but the account holds an open show, or the
 *   guard query itself failed. Deferred to the next run; nothing is written.
 * - `downgrade-disabled` — overdue, but `STATION_SIGNUP_DOWNGRADE_ENABLED`
 *   is not `'true'`.
 * - `already-member` — overdue and never downgraded by this job, but the
 *   account does not currently hold `auth_member.role = 'dj'`, so there is
 *   nothing to downgrade.
 */
export type DowngradeStatus =
  'pending' | 'downgraded' | 'already-downgraded' | 'deferred-on-air' | 'downgrade-disabled' | 'already-member';

export interface DowngradeDecision {
  row: PendingSignupRow;
  status: DowngradeStatus;
  /**
   * `now` for `downgraded`, the stored marker for `already-downgraded`,
   * `null` for every other status.
   */
  downgradedAt: Date | null;
  /**
   * Only set on `deferred-on-air`. `open-show` is the real signal;
   * `guard-error` means the guard query threw and the account was deferred
   * anyway, because an unanswerable question must fail toward "wait".
   */
  deferReason?: 'open-show' | 'guard-error';
}

/**
 * Does this account hold an open show right now?
 *
 * `shows.end_time IS NULL AND (primary_dj_id = userId OR EXISTS (show_djs
 * ...))` — served by the partial index `shows_open_start_time_idx`
 * (migration 0154), which is `ON shows (start_time) WHERE end_time IS NULL`
 * and exists for exactly this class of read.
 *
 * **Why an on-air DJ must never be downgraded mid-show.** `POST
 * /flowsheet/end` requires `flowsheet: ['write']`, and the JWT resolves the
 * caller's role live on a ~15-minute expiry — so a DJ demoted to `member`
 * while their show is open cannot sign off. Their abandoned open show then
 * swallows every later DJ's go-live as a silent guest join, because
 * `POST /flowsheet/join` routes start-vs-join on `current_show?.end_time
 * !== null`. That is the corruption `jobs/flowsheet-show-split` repairs by
 * hand, non-re-runnably. A one-day delay costs nothing; this costs a
 * weekend of the flowsheet.
 *
 * Deliberately NOT a "recent flowsheet writes" heuristic: a flowsheet write
 * requires an open show, so the open-show check already subsumes it, and a
 * time-window heuristic would add a tunable with no additional signal.
 *
 * `show_djs.active` is deliberately not filtered. An inactive membership on
 * a show that is still open is still a reason to wait one more day.
 */
export const hasOpenShow = async (dbClient: DbClient, userId: string): Promise<boolean> => {
  const rows = await dbClient
    .select({ id: shows.id })
    .from(shows)
    .where(
      and(
        isNull(shows.end_time),
        or(
          eq(shows.primary_dj_id, userId),
          exists(
            dbClient
              .select({ djId: show_djs.dj_id })
              .from(show_djs)
              .where(and(eq(show_djs.show_id, shows.id), eq(show_djs.dj_id, userId)))
          )
        )
      )
    )
    .limit(1);
  return rows.length > 0;
};

/**
 * Does this account currently hold `auth_member.role = 'dj'`?
 *
 * Scoped by `userId` alone, not `(organizationId, userId)` -- WXYC runs one
 * station org today. Revisit if a second org is ever added.
 */
const holdsDjRole = async (dbClient: DbClient, userId: string): Promise<boolean> => {
  const rows = await dbClient
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.role, 'dj')))
    .limit(1);
  return rows.length > 0;
};

/**
 * Decide, per pending account, what this run will do -- **without writing
 * anything**. `rows` is expected to already be filtered to accounts pending
 * review (`self_signup_at IS NOT NULL AND self_signup_reviewed_at IS NULL`)
 * by `query.ts`; this function re-checks the 30-day boundary, the terminal
 * marker, the kill switch, the current role and the on-air guard.
 *
 * Every read failure in the guard phase is caught and turned into
 * `deferred-on-air` / `guard-error`. The rule is one-directional: an
 * unanswerable question defers the downgrade, it never permits one.
 */
export const planDowngrades = async (
  dbClient: DbClient,
  rows: PendingSignupRow[],
  now: Date
): Promise<DowngradeDecision[]> => {
  const enabled = isDowngradeEnabled();
  const decisions: DowngradeDecision[] = [];

  for (const row of rows) {
    // The terminal marker wins over everything: this account has already
    // been through the actuator once, and once is the contract.
    if (row.selfSignupDowngradedAt !== null) {
      decisions.push({ row, status: 'already-downgraded', downgradedAt: row.selfSignupDowngradedAt });
      continue;
    }

    if (!isPastDowngradeCutoff(row.selfSignupAt, now)) {
      decisions.push({ row, status: 'pending', downgradedAt: null });
      continue;
    }

    if (!enabled) {
      decisions.push({ row, status: 'downgrade-disabled', downgradedAt: null });
      continue;
    }

    try {
      // Role first: an account that is not a `dj` needs no downgrade, so the
      // on-air question is moot and the `shows` read is skipped entirely.
      if (!(await holdsDjRole(dbClient, row.userId))) {
        decisions.push({ row, status: 'already-member', downgradedAt: null });
        continue;
      }
      if (await hasOpenShow(dbClient, row.userId)) {
        decisions.push({ row, status: 'deferred-on-air', downgradedAt: null, deferReason: 'open-show' });
        continue;
      }
    } catch {
      decisions.push({ row, status: 'deferred-on-air', downgradedAt: null, deferReason: 'guard-error' });
      continue;
    }

    decisions.push({ row, status: 'downgraded', downgradedAt: now });
  }

  return decisions;
};

export interface AppliedDowngrades {
  /** Accounts whose `auth_member.role` this run actually flipped `dj` -> `member`. */
  downgraded: PendingSignupRow[];
  /**
   * Planned accounts whose UPDATE matched no row -- the account left `dj`
   * between the plan phase and the write (a manager edit landing mid-run).
   * Nothing is written for these, and no marker is stamped, so they are
   * re-evaluated from scratch on the next run.
   */
  raced: PendingSignupRow[];
  /** Accounts whose write threw. Per-account, so one failure cannot abort the rest. */
  failed: Array<{ row: PendingSignupRow; error: unknown }>;
}

/**
 * Perform the writes for every `downgraded` decision. Runs AFTER the digest
 * has been put on the wire, and runs regardless of whether that send
 * succeeded -- see `orchestrate.ts` for why gating the backstop on SES
 * health would be the wrong coupling.
 *
 * The role flip and the marker stamp go in ONE transaction. Half of this
 * pair is a defect either way: the role without the marker re-fires on the
 * next re-promotion (the bug this change exists to fix), and the marker
 * without the role permanently exempts an account that still holds `dj`
 * from the only backstop there is.
 *
 * The `WHERE role = 'dj'` guard (not just `WHERE user_id = :id`) keeps the
 * write idempotent against a role edit that lands between plan and apply --
 * `returning()` reports whether a row actually matched, and the marker is
 * stamped only when one did.
 *
 * One transaction per account rather than a single batched `IN (...)` -- the
 * pending cohort is small (self-signup is a rare event, not a bulk import),
 * so the simplicity of an independent per-row result outweighs the batching
 * this table's normal write volume would otherwise call for.
 *
 * `auth_user.updated_at` is deliberately left alone: it is better-auth's
 * column, and the privilege change lives on `auth_member`.
 */
export const applyDowngrades = async (
  dbClient: DbClient,
  decisions: DowngradeDecision[],
  now: Date
): Promise<AppliedDowngrades> => {
  const result: AppliedDowngrades = { downgraded: [], raced: [], failed: [] };

  for (const decision of decisions) {
    if (decision.status !== 'downgraded') continue;
    const { row } = decision;

    try {
      const flipped = await dbClient.transaction(async (tx) => {
        const updated = await tx
          .update(member)
          .set({ role: 'member' })
          .where(and(eq(member.userId, row.userId), eq(member.role, 'dj')))
          .returning({ id: member.id });

        if (updated.length === 0) return false;

        await tx
          .update(user)
          .set({ selfSignupDowngradedAt: now })
          .where(and(eq(user.id, row.userId), isNull(user.selfSignupDowngradedAt)));

        return true;
      });

      if (flipped) result.downgraded.push(row);
      else result.raced.push(row);
    } catch (error) {
      result.failed.push({ row, error });
    }
  }

  return result;
};
