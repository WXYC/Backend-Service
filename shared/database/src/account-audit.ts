/**
 * The account-modification audit trail's storage substrate (BS#2536, parent
 * epic #2534): a single-INSERT writer and its paired prune. No call sites in
 * this PR — the coverage issue (BS#2537) wires the Express-layer decorator
 * that calls `recordAccountAuditEvent`; this module only has to exist and
 * behave correctly in isolation.
 *
 * Lives in `@wxyc/database` rather than `@wxyc/authentication` because
 * `jobs/station-signup-review` (the job.ts self-signup-downgrade writer)
 * imports `@wxyc/database`, not `@wxyc/authentication`, and because
 * `scripts/**` is outside lint/typecheck so statement logic has to sit in a
 * linted, typechecked workspace.
 */
import { randomUUID } from 'crypto';
import { lt } from 'drizzle-orm';
import { db } from './client.js';
import { account_audit_event } from './schema.js';

/** 'http' — the Express audit-decorator mounts. 'job' — a cron-sourced event. */
export type AccountAuditEventSource = 'http' | 'job';

export interface AccountAuditEventInput {
  /** Path-derived dotted slug, e.g. 'admin.set-role', 'forget-password'. */
  action: string;
  /** NULL = unauthenticated request or a job-sourced event. */
  actorUserId?: string | null;
  /** From `auth_session.impersonatedBy` when the actor was impersonating. */
  impersonatorUserId?: string | null;
  /** Best-effort resolution from the request body; NULL when unresolvable. */
  subjectUserId?: string | null;
  /** Raw HTTP status code. Jobs (`source: 'job'`) use 200. */
  outcome: number;
  /** Populated only when the response body carried a string `code` for a >=400 outcome. */
  errorCode?: string | null;
  /** Keyed HMAC over the client IP (the station_signup_attempt recipe). NULL for jobs. */
  ipHash?: string | null;
  source: AccountAuditEventSource;
}

export interface RecordAccountAuditEventDeps {
  /**
   * `@wxyc/database` declares no `@sentry/node` dependency and must not gain
   * one — it sits in the dependency closure of every workspace. Callers
   * that already import Sentry (apps/auth, jobs/*) pass
   * `Sentry.captureException` tagged `subsystem: 'account-audit'`. The
   * `AdminFlagSyncDeps.onError` idiom (shared/authentication/src/admin-flag-sync.ts).
   */
  onError: (error: unknown) => void;
}

/**
 * Single INSERT, never throws. Every audit write is fire-and-forget by
 * design (parent epic decision 7): the HTTP middleware that will call this
 * hooks `res.on('finish')`, after the response is already sent, so there is
 * nothing left to fail closed. A write failure reaches Sentry via the
 * injected `onError` instead of propagating to the caller.
 */
export async function recordAccountAuditEvent(
  event: AccountAuditEventInput,
  deps: RecordAccountAuditEventDeps
): Promise<void> {
  try {
    await db.insert(account_audit_event).values({
      id: randomUUID(),
      occurredAt: new Date(),
      action: event.action,
      actorUserId: event.actorUserId ?? null,
      impersonatorUserId: event.impersonatorUserId ?? null,
      subjectUserId: event.subjectUserId ?? null,
      outcome: event.outcome,
      errorCode: event.errorCode ?? null,
      ipHash: event.ipHash ?? null,
      source: event.source,
    });
  } catch (error) {
    // The catch body itself must not throw: a broken Sentry transport (or
    // any other throwing onError) would turn a swallowed audit-write
    // failure into an unhandled rejection in whatever fire-and-forget
    // caller wires this up (the HTTP `res.on('finish')` decorator, per
    // parent epic decision 2) — there is nothing left to report it to, so
    // the only correct move is to drop it silently.
    try {
      deps.onError(error);
    } catch {
      /* nothing left to do */
    }
  }
}

/** 2-year retention (parent epic decision 9): forensic questions at a student station surface on academic-year timescales. */
export const ACCOUNT_AUDIT_EVENT_DEFAULT_RETENTION_DAYS = 730;

export interface PruneAccountAuditEventsOptions {
  olderThanDays?: number;
  now?: Date;
}

/**
 * Delete rows older than the retention window (default 730 days). Mirrors
 * `pruneSignupAttempts` (shared/authentication/src/station-passcode.ts) —
 * same cutoff-boundary semantics (strictly older survives at the exact
 * cutoff instant), same "run from a job, not the request path" contract.
 * Does not catch its own errors: `jobs/auth-log-prune/job.ts` wraps this
 * call in its own try/catch, separate from the `pruneSignupAttempts` one, so
 * one prune failing cannot silently skip the other.
 */
export async function pruneAccountAuditEvents(options: PruneAccountAuditEventsOptions = {}): Promise<number> {
  const { olderThanDays = ACCOUNT_AUDIT_EVENT_DEFAULT_RETENTION_DAYS, now = new Date() } = options;
  // This table's whole justification is surviving deletion (parent epic
  // decision 5/9) — an unqualified DELETE from a non-positive or
  // non-finite `olderThanDays` would wipe the entire audit trail instead of
  // pruning it. `pruneSignupAttempts` has no equivalent guard; that is a
  // pre-existing gap on a 30-day table, not a precedent to copy onto a
  // table whose retention is the whole point.
  if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
    throw new Error(`pruneAccountAuditEvents: olderThanDays must be a positive finite number, got ${olderThanDays}`);
  }
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const deleted = await db.delete(account_audit_event).where(lt(account_audit_event.occurredAt, cutoff));
  return deleted.count;
}
