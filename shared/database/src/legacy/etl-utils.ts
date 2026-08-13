/**
 * Shared utilities for ETL jobs that sync data from tubafrenzy.
 *
 * Used by both flowsheet-etl and rotation-etl. Generic helpers for
 * MirrorSQL output parsing, timestamp conversion, cronjob tracking,
 * Backend-Service notification, and polling loops.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../client.js';
import { cronjob_runs } from '../schema.js';

// ---- MirrorSQL Output Parsing ----

/**
 * Parse a tab-separated row from MirrorSQL output.
 * Returns the columns array if the column count matches, or null if malformed.
 */
export const parseTabRow = (line: string, columnCount: number): string[] | null => {
  const columns = line.split('\t');
  return columns.length === columnCount ? columns : null;
};

/**
 * Normalize a MirrorSQL column value: trim whitespace and treat empty
 * strings and the literal "NULL" as null.
 */
export const toNullable = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed === 'NULL' ? null : trimmed;
};

// ---- Timestamp Conversion ----

/**
 * Convert an epoch milliseconds value to a JS Date.
 * Returns null for null, 0 (tubafrenzy uses 0 for "not set"), and NaN.
 */
export const epochMsToDate = (epochMs: number | null): Date | null => {
  if (epochMs == null || epochMs === 0 || !Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * How far into the future an upstream (tubafrenzy) timestamp may legitimately
 * drift before it's treated as bad data rather than ordinary clock skew
 * (BS#2143). 5 minutes comfortably covers NTP-class drift between the
 * tubafrenzy host and this service without being wide enough to mask a
 * genuinely misconfigured clock.
 *
 * A plain constant, not an env var. The past-side sibling,
 * `LIVE_FS_INSERT_MAX_AGE_HOURS`
 * (apps/backend/services/metadata-broadcast/metadata-broadcast.ts), is
 * env-gated because it's a kill switch — an operator may need to widen or
 * disable that broadcast filter in production without a deploy. This bound
 * has no analogous "turn it off" case (clamping a future timestamp to now is
 * always the right call), so an env var would buy nothing but a
 * docs/env-vars.md entry.
 */
export const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * True when `date` is more than `FUTURE_TIMESTAMP_TOLERANCE_MS` ahead of
 * `now`. Pure predicate — `now` is injectable so callers (and their tests)
 * don't depend on wall-clock timing. `date === null` is never "beyond
 * tolerance" (there's nothing to flag).
 *
 * Deliberately NOT folded into `epochMsToDate` above (BS#2143). That
 * converter also produces `radio_hour`, and a breakpoint's `radio_hour` is
 * LEGITIMATELY in the near future — tubafrenzy logs a breakpoint marker
 * roughly a minute before the top-of-hour it marks (see `resolveRadioHour`'s
 * doc comment in jobs/flowsheet-etl/transform.ts, BS#1449). Clamping inside
 * the shared converter would silently shift every breakpoint hour backward
 * and reintroduce the exact bug BS#1449 fixed. Callers that need a future
 * bound (the webhook's `markerTimestamp` / `add_time`, and
 * `resolveEntryTimestamp` in jobs/flowsheet-etl/transform.ts) apply this
 * predicate themselves, after conversion, only to the fields that actually
 * need it — never inside `epochMsToDate` itself.
 *
 * Note the precise scope of that argument: it rules out the bound living in
 * the SHARED CONVERTER, not the bound ever being applied to `radio_hour`. The
 * 5-minute tolerance comfortably exceeds the ~1-minute legitimate lead
 * BS#1449 relies on, so a per-call-site bound on `radio_hour` would be
 * coherent — it is simply out of scope for BS#2143, which is about the
 * `add_time` sort key. `radio_hour` is left unbounded here as a known,
 * deliberate gap: a skewed upstream clock can still write a breakpoint hour
 * that hasn't happened, which `computeHourMs`
 * (apps/backend/services/playlist-proxy.service.ts) passes through verbatim
 * to the mobile clients. That's cosmetic (it pins no window and freezes no
 * header), and the 2026-08-13 production sweep found zero
 * `radio_hour > now()` rows — but it is unfixed, not disproven.
 */
export const isBeyondFutureTolerance = (date: Date | null, now: Date = new Date()): boolean => {
  if (date === null) return false;
  return date.getTime() - now.getTime() > FUTURE_TIMESTAMP_TOLERANCE_MS;
};

/**
 * Truncate a string to a max length, returning null if empty.
 * Matches the VARCHAR limits in the schema (128 for names, 250 for messages).
 *
 * Postgres `varchar(n)` counts Unicode codepoints, not UTF-16 code units or
 * bytes, so truncation walks codepoints too (BS#1090). `String.prototype.slice`
 * counts UTF-16 code units: a codepoint outside the Basic Multilingual Plane
 * (any 4-byte-UTF-8 character — emoji, many CJK Extension B+ ideographs) is
 * stored as a surrogate *pair*, and a naive code-unit slice can land between
 * the high and low surrogate, splitting the pair into invalid UTF-16 that
 * serializes to invalid/lossy UTF-8 on the wire to Postgres. `Array.from`
 * (like the spread operator) iterates by codepoint, keeping surrogate pairs
 * intact. This function backs both the tubafrenzy webhook receiver's live
 * write path (`apps/backend/routes/internal.route.ts`, via the `truncate`
 * export of `@wxyc/database`) and the flowsheet/rotation ETL jobs.
 */
export const truncate = (value: string | null | undefined, maxLength: number): string | null => {
  if (!value || value.trim().length === 0) return null;
  const trimmed = value.trim();
  // Fast path: codepoint count can never exceed UTF-16 code-unit count, so a
  // trimmed string within the limit by code-unit length is always within the
  // limit by codepoint count too — skip the Array.from materialization below.
  if (trimmed.length <= maxLength) return trimmed;
  const codepoints = Array.from(trimmed);
  return codepoints.length <= maxLength ? trimmed : codepoints.slice(0, maxLength).join('');
};

// ---- Cronjob Run Tracking ----

/**
 * Get the last run timestamp for a named ETL job from the cronjob_runs table.
 * Returns epoch milliseconds, or null if the job has never run.
 */
export const getLastRunTimestamp = async (jobName: string): Promise<number | null> => {
  const response = await db
    .select({ lastRun: cronjob_runs.last_run })
    .from(cronjob_runs)
    .where(eq(cronjob_runs.job_name, jobName))
    .limit(1);
  const lastRun = response[0]?.lastRun ?? null;
  return lastRun ? lastRun.getTime() : null;
};

/**
 * Record the last run timestamp for a named ETL job.
 * Uses upsert so the first call creates the row and subsequent calls update it.
 */
export const updateLastRun = async (jobName: string, timestamp: Date): Promise<void> => {
  await db
    .insert(cronjob_runs)
    .values({ job_name: jobName, last_run: timestamp })
    .onConflictDoUpdate({
      target: cronjob_runs.job_name,
      set: { last_run: timestamp },
    });
};

// ---- Backend-Service Notification ----

/**
 * Notify Backend-Service that an ETL sync completed, triggering SSE refetch
 * for connected clients. Best-effort: logs warnings on failure but never throws.
 *
 * @param notifyPath - The internal endpoint path (e.g. '/internal/flowsheet-sync-notify')
 */
export const notifyBackendService = async (notifyPath: string): Promise<void> => {
  const url = process.env.BACKEND_SERVICE_URL ?? 'http://localhost:8080';
  const key = process.env.ETL_NOTIFY_KEY ?? '';
  try {
    const response = await fetch(`${url}${notifyPath}`, {
      method: 'POST',
      headers: { 'X-Internal-Key': key },
    });
    if (!response.ok) {
      console.warn(`[etl] Backend notify ${notifyPath} returned ${response.status}`);
    }
  } catch (e) {
    console.warn(`[etl] Failed to notify backend (${notifyPath}):`, e);
  }
};

// ---- Polling Loop ----

export type PollingOptions = {
  /** Poll interval in milliseconds (default: 30000) */
  intervalMs?: number;
  /** Job name for logging (e.g. 'flowsheet-etl') */
  jobName: string;
  /** Notification path called after changes (e.g. '/internal/flowsheet-sync-notify') */
  notifyPath: string;
};

export type SyncResult = {
  /** Whether any data changed (triggers SSE notification) */
  hasChanges: boolean;
};

/**
 * Run an ETL sync function in a continuous polling loop with graceful shutdown.
 * Calls notifyBackendService after each sync pass that reports changes.
 */
export const runPollingLoop = async (syncFn: () => Promise<SyncResult>, options: PollingOptions): Promise<void> => {
  const intervalMs = options.intervalMs ?? (Number(process.env.ETL_POLL_INTERVAL_MS) || 30_000);
  let running = true;
  let sleepResolve: (() => void) | null = null;

  const shutdown = () => {
    running = false;
    sleepResolve?.();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[${options.jobName}] Polling every ${intervalMs}ms. PID ${process.pid}`);

  while (running) {
    try {
      const result = await syncFn();
      if (result.hasChanges) {
        await notifyBackendService(options.notifyPath);
      }
    } catch (e) {
      console.error(`[${options.jobName}] Poll error:`, e);
    }
    if (!running) break;
    await new Promise<void>((resolve) => {
      sleepResolve = resolve;
      setTimeout(resolve, intervalMs);
    });
  }

  console.log(`[${options.jobName}] Shutting down.`);
};
