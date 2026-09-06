/**
 * Manager operations for the station self-signup passcode (BS#2362).
 *
 * Six operations — reveal, rotate, revoke, clear-cooldown, status, approve —
 * behind the same admin-flag gate `/auth/admin/provision-user` uses. The
 * route wiring and that gate live in `app.ts`; this module holds the two
 * operations with logic of their own (status and approve) plus the shared
 * error type, and leaves the other four as thin delegations to
 * `@wxyc/authentication`'s lifecycle module, which owns every statement
 * against `station_passcode` and `station_signup_attempt`.
 *
 * WHY THE GATE IS THE ADMIN FLAG AND NOT "stationManager only". Via
 * `grantsAdminFlag` the flag also admits a stray `admin`/`owner` membership
 * row, so this is a slightly wider set than the station-manager role. That is
 * the right trade rather than an oversight: `/auth/admin/provision-user`
 * already sits behind exactly this gate and CREATES ACCOUNTS AT ANY ROLE,
 * `stationManager` included, so nothing here is a wider grant than what the
 * same gate already protects. A true membership-role gate would need a read
 * nothing in `apps/auth` does today; if it is ever wanted it is its own
 * change with its own test, applied to both endpoints at once.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db, member, user } from '@wxyc/database';
import {
  evaluateSignupCooldown,
  readRecentSignupAttempts,
  readStationPasscodeStates,
  SIGNUP_COOLDOWN_HOLD_MS,
  SIGNUP_COOLDOWN_THRESHOLD,
  SIGNUP_COOLDOWN_WINDOW_MS,
  type StationPasscodeStateRow,
} from '@wxyc/authentication';

/** Thrown by the operations below; `app.ts` maps `statusCode` straight onto the response. */
export class StationSignupAdminError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'StationSignupAdminError';
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Attempt-log window the status endpoint reports over, unless the caller narrows it. */
export const STATUS_ATTEMPT_WINDOW_HOURS = 24;

/** Cap on the individual attempt rows returned alongside the counts. */
export const STATUS_ATTEMPT_ROW_LIMIT = 100;

/**
 * One attempt row as the status endpoint reports it.
 *
 * `ipHash` is included deliberately. It is PSEUDONYMOUS rather than PII (a
 * keyed HMAC — see `docs/pii.md` and the column's own comment in
 * `schema.ts`), and "manager forensic tooling" is precisely its allow-listed
 * read site: the question this endpoint exists to answer after a suspected
 * leak is what an attack looked like and who revealed the code.
 */
export interface StationSignupAttemptView {
  id: string;
  attemptedAt: Date;
  outcome: string;
  passcodeId: string | null;
  actorUserId: string | null;
  ipHash: string | null;
}

/** One self-signed-up account still awaiting a manager's review. */
export interface PendingReviewAccountView {
  userId: string;
  /**
   * `auth_user.name` — the derived public display value (on-air handle else
   * username), NOT the legal name; the `databaseHooks.user` derivation hooks
   * hold that invariant on every write. `real_name` and `email` are PII and
   * are deliberately absent: dj-site's roster already carries what a manager
   * needs to identify the account, and this response has no reason to widen
   * that surface.
   */
  name: string;
  djName: string | null;
  selfSignupAt: Date;
  /** Whole days between `selfSignupAt` and `now`, floored — what the 30-day backstop counts. */
  daysPending: number;
  /**
   * When `jobs/station-signup-review`'s actuator flipped this account
   * `dj` -> `member`, or null if it never did. Surfaced here because a
   * manager looking at a `member`-role account in the queue otherwise cannot
   * tell "auto-downgraded, needs re-promoting" from "signed up as a member".
   */
  selfSignupDowngradedAt: Date | null;
}

export interface StationSignupStatus {
  now: Date;
  /** Active rows plus every row that went inactive inside the 30-day horizon. Never any plaintext. */
  passcodes: StationPasscodeStateRow[];
  cooldown: {
    inCooldown: boolean;
    /** In-window `passcode_fail` count — the only outcome that feeds refusal. */
    noMatchFailureCount: number;
    /** In-window count across every failure outcome, including the refusal-exempt ones. */
    allFailureCount: number;
    /** The rule the two counts are measured against, so a client need not restate the constants. */
    windowMinutes: number;
    holdMinutes: number;
    /** Refusal triggers on MORE than this many no-match failures in the window. */
    threshold: number;
    /**
     * The most recent `cooldown_cleared` row inside the reported attempt
     * window, or null. Scoped to that window rather than to all history: an
     * older clear has no bearing on the cooldown state above, which only ever
     * looks back window+hold.
     */
    lastClearedAt: Date | null;
  };
  attempts: {
    since: Date;
    windowHours: number;
    /** Every outcome seen in the window, counted. Absent outcomes are absent, not zero. */
    countsByOutcome: Record<string, number>;
    /** Newest first, capped at STATUS_ATTEMPT_ROW_LIMIT. */
    recent: StationSignupAttemptView[];
  };
  pendingReview: PendingReviewAccountView[];
}

export interface ReadStationSignupStatusOptions {
  now?: Date;
  windowHours?: number;
  attemptLimit?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Everything a manager needs to answer "is the gate working, and is anything
 * waiting on me?" in one read. Purely read-only — no attempt row, no audit
 * row, nothing. That is what makes it safe to poll, and it is why revealing
 * the plaintext is a separate POST: reveal is the operation that writes the
 * `passcode_revealed` audit row, and folding it in here would either spam the
 * log on every poll or quietly hand out the code without one.
 */
export const readStationSignupStatus = async (
  options: ReadStationSignupStatusOptions = {}
): Promise<StationSignupStatus> => {
  const now = options.now ?? new Date();
  const windowHours = options.windowHours ?? STATUS_ATTEMPT_WINDOW_HOURS;
  const attemptLimit = options.attemptLimit ?? STATUS_ATTEMPT_ROW_LIMIT;
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  const [passcodes, cooldown, attempts, pending] = await Promise.all([
    readStationPasscodeStates({ now }),
    evaluateSignupCooldown(now),
    readRecentSignupAttempts({ since, limit: attemptLimit }),
    db
      .select({
        userId: user.id,
        name: user.name,
        djName: user.djName,
        selfSignupAt: user.selfSignupAt,
        selfSignupDowngradedAt: user.selfSignupDowngradedAt,
      })
      .from(user)
      // The SAME cohort `jobs/station-signup-review/query.ts` digests and
      // dj-site's roster review queue shows: `self_signup_at IS NOT NULL AND
      // self_signup_reviewed_at IS NULL`, and deliberately NOT narrowed by
      // `self_signup_downgraded_at` — an account the actuator already
      // downgraded must keep appearing until a human actually reviews it.
      // Restated rather than imported: `apps/auth` cannot depend on a
      // `jobs/*` workspace, so if that predicate ever moves, both copies
      // move.
      .where(and(isNotNull(user.selfSignupAt), isNull(user.selfSignupReviewedAt))),
  ]);

  const countsByOutcome: Record<string, number> = {};
  for (const attempt of attempts) {
    countsByOutcome[attempt.outcome] = (countsByOutcome[attempt.outcome] ?? 0) + 1;
  }

  const cleared = attempts.find((attempt) => attempt.outcome === 'cooldown_cleared');

  return {
    now,
    passcodes,
    cooldown: {
      inCooldown: cooldown.inCooldown,
      noMatchFailureCount: cooldown.noMatchFailureCount,
      allFailureCount: cooldown.allFailureCount,
      windowMinutes: SIGNUP_COOLDOWN_WINDOW_MS / 60000,
      holdMinutes: SIGNUP_COOLDOWN_HOLD_MS / 60000,
      threshold: SIGNUP_COOLDOWN_THRESHOLD,
      lastClearedAt: cleared?.attemptedAt ?? null,
    },
    attempts: {
      since,
      windowHours,
      countsByOutcome,
      recent: attempts.map((attempt) => ({
        id: attempt.id,
        attemptedAt: attempt.attemptedAt,
        outcome: attempt.outcome,
        passcodeId: attempt.passcodeId,
        actorUserId: attempt.actorUserId,
        ipHash: attempt.ipHash,
      })),
    },
    pendingReview: pending
      .filter((row): row is typeof row & { selfSignupAt: Date } => row.selfSignupAt !== null)
      .map((row) => ({
        userId: row.userId,
        name: row.name,
        djName: row.djName,
        selfSignupAt: row.selfSignupAt,
        daysPending: Math.floor((now.getTime() - row.selfSignupAt.getTime()) / MS_PER_DAY),
        selfSignupDowngradedAt: row.selfSignupDowngradedAt,
      }))
      .sort((a, b) => b.daysPending - a.daysPending),
  };
};

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

export interface ApproveSelfSignupParams {
  userId: string;
  /**
   * The ACTING manager's `auth_user.id`, derived server-side from the session
   * by the route — never client-supplied. That is the whole point of the
   * parameter: the column is an attribution record, and a caller who could
   * name someone else could file a review under another manager's id.
   */
  reviewerId: string;
  /**
   * Additionally restore `auth_member.role` `member` -> `dj` in the same
   * transaction. There is deliberately no free-form role parameter: `'dj'` is
   * a literal in the UPDATE below, so this endpoint is structurally incapable
   * of granting anything else.
   */
  restoreDjRole?: boolean;
  now?: Date;
}

export interface ApproveSelfSignupResult {
  userId: string;
  reviewedAt: Date;
  /** Null only in the degenerate case of a pre-existing review stamp with no reviewer recorded. */
  reviewedBy: string | null;
  /** True when this call did the stamping; false when an earlier review already had. */
  reviewedByThisCall: boolean;
  /** Preserved as history, never cleared by approval. Null if the actuator never fired. */
  selfSignupDowngradedAt: Date | null;
  /** True only when this call actually flipped a `member` row to `dj`. */
  roleRestored: boolean;
  /** `auth_member.role` as it stands after this call, or null if the account has no membership row. */
  memberRole: string | null;
}

/**
 * Mark a self-signed-up account reviewed, and optionally hand back the `dj`
 * role the 30-day actuator took.
 *
 * NOT via better-auth's public `POST /update-user`. All three review columns
 * carry `input: false` (`auth.definition.ts`), which blocks that route BY
 * DESIGN — it is what stops a signed-in DJ approving their own pending
 * signup. This writes through `@wxyc/database` directly, which never reaches
 * `parseUserInput`, exactly as `jobs/station-signup-review` does for
 * `self_signup_downgraded_at`. A direct write is not merely one of the
 * permitted bypasses here, it is the only one that can hold the role restore
 * in the SAME transaction as the review stamp — the admin plugin's
 * `adminUpdateUser` would put the two writes in different transactions and
 * reintroduce the half-applied state the lock order below exists to prevent.
 *
 * **LOCK ORDER — mandatory.** `SELECT ... FOR UPDATE` on the `auth_user` row
 * FIRST, then the `auth_member` write. `jobs/station-signup-review`'s
 * `applyDowngrades` holds the same order and names this endpoint in its
 * docstring as the writer that has to match it; taking them the other way
 * round deadlocks the pair, and the job's loser lands in its `failed` /
 * non-zero path rather than its benign `raced` one. Because both sides lock
 * the same row first they simply serialize: approve-then-downgrade leaves the
 * job's re-select filtering the row out into `raced`, and downgrade-then-
 * approve leaves this call approving an account that is already `member` —
 * which is precisely what `restoreDjRole` is for.
 *
 * **`self_signup_downgraded_at` is PRESERVED**, never cleared. It records
 * what happened to the account; approving is not a history edit. The column
 * also suppresses the actuator, so an approved account can never be
 * auto-downgraded a second time whether or not the review stamp is what did
 * the suppressing.
 *
 * **Without `restoreDjRole`, an already-downgraded account stays `member`**
 * and simply leaves the pending cohort (`self_signup_reviewed_at` is
 * non-null). That is a real outcome, not an oversight: a manager reviewing a
 * self-signup may well decide the person should not be a DJ, and the quiet
 * default has to be "grant nothing".
 *
 * **The review stamp is write-once.** A second approval does not re-attribute
 * the review to a second manager — the UPDATE carries
 * `self_signup_reviewed_at IS NULL` — but a `restoreDjRole` on that second
 * call still applies, so "approve, then realise the role should come back" is
 * one more call rather than a dead end.
 */
export const approveSelfSignup = async (params: ApproveSelfSignupParams): Promise<ApproveSelfSignupResult> => {
  const now = params.now ?? new Date();

  return db.transaction(async (tx) => {
    // FIRST — see the lock-order paragraph above. Everything this function
    // decides is read from the locked row, so a concurrent downgrade either
    // waits here or has already committed and is visible below.
    const [account] = await tx
      .select({
        id: user.id,
        selfSignupAt: user.selfSignupAt,
        selfSignupReviewedAt: user.selfSignupReviewedAt,
        selfSignupReviewedBy: user.selfSignupReviewedBy,
        selfSignupDowngradedAt: user.selfSignupDowngradedAt,
      })
      .from(user)
      .where(eq(user.id, params.userId))
      .limit(1)
      .for('update');

    if (!account) {
      throw new StationSignupAdminError(`No such user: ${params.userId}`, 404);
    }
    if (account.selfSignupAt === null) {
      // The three review columns only mean anything for an account that came
      // in through the self-signup gate. Stamping them on an
      // admin-provisioned account would put a row in the reviewed state that
      // was never in the pending one.
      throw new StationSignupAdminError(`User ${params.userId} did not self-sign up; there is nothing to review`, 409);
    }

    const stamped = await tx
      .update(user)
      .set({ selfSignupReviewedAt: now, selfSignupReviewedBy: params.reviewerId })
      .where(and(eq(user.id, params.userId), isNull(user.selfSignupReviewedAt)))
      .returning({ id: user.id });
    const reviewedByThisCall = stamped.length > 0;

    let roleRestored = false;
    if (params.restoreDjRole) {
      // `'dj'` on both sides is a literal, and the WHERE pins the source role
      // to `'member'`: the only transition this endpoint can perform is the
      // exact inverse of the actuator's `dj` -> `member`. An account sitting
      // at `musicDirector` or `stationManager` is left alone rather than
      // silently demoted to `dj`, which an unguarded `SET role = 'dj'` would
      // do.
      const restored = await tx
        .update(member)
        .set({ role: 'dj' })
        .where(and(eq(member.userId, params.userId), eq(member.role, 'member')))
        .returning({ id: member.id });
      roleRestored = restored.length > 0;
    }

    const [membership] = await tx
      .select({ role: member.role })
      .from(member)
      .where(eq(member.userId, params.userId))
      .limit(1);

    return {
      userId: params.userId,
      // `selfSignupReviewedAt` is non-null whenever the stamp did not fire —
      // that is exactly the condition the UPDATE's WHERE failed on.
      reviewedAt: reviewedByThisCall ? now : (account.selfSignupReviewedAt as Date),
      reviewedBy: reviewedByThisCall ? params.reviewerId : account.selfSignupReviewedBy,
      reviewedByThisCall,
      selfSignupDowngradedAt: account.selfSignupDowngradedAt,
      roleRestored,
      memberRole: membership?.role ?? null,
    };
  });
};
