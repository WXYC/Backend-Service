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
