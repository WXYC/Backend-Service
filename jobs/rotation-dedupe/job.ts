/**
 * One-shot dedupe: collapse duplicate active rotation rows for the same
 * (album_id, rotation_bin) by killing all but the most recent (#694).
 *
 * Why this job exists: tubafrenzy historically allowed multiple rotation
 * entries for the same album over time (one per "rotation cycle"). When the
 * rotation table was synced into Backend-Service those historical entries
 * were preserved without collapsing — even though for an active rotation
 * list, only the most recent unkilled entry per album+bucket is meaningful.
 * The dj-site rotation dropdown renders every active row, so a single album
 * with nine duplicate rows surfaces nine times in its bucket. Live evidence
 * from 2026-05-01: Little Brother — And Justus For All Mixtape, album_id
 * 39330, rotation_bin H, 9 active rows all add_date=2007-05-16.
 *
 * Algorithm: for each (album_id, rotation_bin) group with multiple active
 * rows (where `kill_date IS NULL OR kill_date > CURRENT_DATE`), keep the
 * row with the most recent `add_date` (ties broken by lowest `id`) and
 * set `kill_date = CURRENT_DATE` on the rest. The whole pass runs inside a
 * single transaction so either all kills land or none do — there is no
 * intermediate state where the rotation list is half-deduped.
 *
 * Idempotency: the WHERE filter restricts to groups with HAVING COUNT(*)
 * > 1 over active rows. After a successful run, every (album_id,
 * rotation_bin) group has exactly one active row, so the next run finds
 * zero candidates and returns 0 rows-killed. This mirrors the canonical
 * one-shot pattern in `jobs/library-artist-name-backfill/`.
 *
 * Companion migration: a unique partial index on (album_id, rotation_bin)
 * WHERE kill_date IS NULL OR kill_date > CURRENT_DATE prevents recurrence.
 * The migration is DDL-only per CLAUDE.md; this job runs separately.
 *
 * Run procedure: build via `Manual Build & Deploy` with
 * `target=rotation-dedupe`, then SSH to EC2 and
 * `docker run --rm --env-file .env <image> 2>&1 | tee log` during a
 * low-traffic window.
 */

import { sql } from 'drizzle-orm';
import { closeDatabaseConnection, db } from '@wxyc/database';
import { captureError, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'rotation-dedupe';

/**
 * Schema-qualified table reference, honoring `WXYC_SCHEMA_NAME` so parallel
 * Jest workers (which override the env var) and any future integration test
 * harness target the right schema. The default `wxyc_schema` matches
 * production. Sanitized against `"` to keep the SQL well-formed.
 */
const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const ROTATION_TABLE = sql.raw(`"${SCHEMA}"."rotation"`);

export type DedupeResult = {
  groupsCollapsed: number;
  rowsKilled: number;
  rowsRemainingActive: number;
};

/**
 * Apply the dedupe in a single transaction. Returns the number of groups
 * collapsed and the number of rows killed.
 *
 * The CTE picks one keeper per (album_id, rotation_bin) group with active
 * duplicate rows, ordered by `add_date DESC, id ASC`. The UPDATE then
 * stamps every other active row in those groups with `kill_date =
 * CURRENT_DATE`. The keeper-row predicate is intentionally stricter than
 * "max add_date" — postgres's DISTINCT ON is the correct primitive for
 * ties-broken-by-second-key, and using it makes the keeper choice
 * deterministic without an extra window function.
 */
export const applyDedupe = async (): Promise<{ rowsKilled: number; groupsCollapsed: number }> => {
  return db.transaction(async (tx) => {
    const dupGroupsResult = await tx.execute(sql`
      SELECT COUNT(*)::int AS dup_groups
      FROM (
        SELECT "album_id", "rotation_bin"
        FROM ${ROTATION_TABLE}
        WHERE "album_id" IS NOT NULL
          AND ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)
        GROUP BY "album_id", "rotation_bin"
        HAVING COUNT(*) > 1
      ) g
    `);
    const groupsCollapsed = Number((dupGroupsResult as unknown as Array<{ dup_groups: number }>)[0]?.dup_groups ?? 0);

    if (groupsCollapsed === 0) {
      return { rowsKilled: 0, groupsCollapsed: 0 };
    }

    const updateResult = await tx.execute(sql`
      WITH keepers AS (
        SELECT DISTINCT ON ("album_id", "rotation_bin") "id"
        FROM ${ROTATION_TABLE}
        WHERE "album_id" IS NOT NULL
          AND ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)
        ORDER BY "album_id", "rotation_bin", "add_date" DESC, "id" ASC
      ),
      dup_groups AS (
        SELECT "album_id", "rotation_bin"
        FROM ${ROTATION_TABLE}
        WHERE "album_id" IS NOT NULL
          AND ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)
        GROUP BY "album_id", "rotation_bin"
        HAVING COUNT(*) > 1
      )
      UPDATE ${ROTATION_TABLE} AS r
      SET "kill_date" = CURRENT_DATE
      FROM dup_groups d
      WHERE r."album_id" = d."album_id"
        AND r."rotation_bin" = d."rotation_bin"
        AND (r."kill_date" IS NULL OR r."kill_date" > CURRENT_DATE)
        AND r."id" NOT IN (SELECT "id" FROM keepers)
    `);
    const rowsKilled = Number((updateResult as { count?: number }).count ?? 0);
    return { rowsKilled, groupsCollapsed };
  });
};

/**
 * Verify the dedupe is complete: zero (album_id, rotation_bin) groups with
 * more than one active row remain. Logs the count and (only) raises if any
 * remain — operator-friendly output even on success.
 */
export const verifyComplete = async (): Promise<{ remainingDupGroups: number }> => {
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS remaining
    FROM (
      SELECT "album_id", "rotation_bin"
      FROM ${ROTATION_TABLE}
      WHERE "album_id" IS NOT NULL
        AND ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)
      GROUP BY "album_id", "rotation_bin"
      HAVING COUNT(*) > 1
    ) g
  `);
  const remaining = Number((result as unknown as Array<{ remaining: number }>)[0]?.remaining ?? 0);
  if (remaining > 0) {
    throw new Error(
      `[${JOB_NAME}] Verification failed: ${remaining} (album_id, rotation_bin) group(s) still have ` +
        `more than one active row. The dedupe transaction may have rolled back, or new duplicate ` +
        `rows were inserted between the apply and the verify (the unique partial index from the ` +
        `companion migration is the durable fix). Re-run the job — it is idempotent.`
    );
  }
  return { remainingDupGroups: 0 };
};

/**
 * Count currently-active rotation rows for the started/finished log lines.
 * Cheap (one COUNT over the active partial set) and informative for ops.
 */
export const countActiveRows = async (): Promise<number> => {
  const result = await db.execute(sql`
    SELECT COUNT(*)::int AS active
    FROM ${ROTATION_TABLE}
    WHERE "album_id" IS NOT NULL
      AND ("kill_date" IS NULL OR "kill_date" > CURRENT_DATE)
  `);
  return Number((result as unknown as Array<{ active: number }>)[0]?.active ?? 0);
};

/** Format a millisecond duration as `Xm Ys`. */
export const formatDuration = (ms: number): string => {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
};

export const runDedupe = async (): Promise<DedupeResult> => {
  const startedAt = Date.now();
  const activeBefore = await countActiveRows();
  log('info', 'started', `${JOB_NAME} starting`, { active_rows_before: activeBefore });

  const { rowsKilled, groupsCollapsed } = await applyDedupe();

  await verifyComplete();

  const elapsedMs = Date.now() - startedAt;
  const activeAfter = await countActiveRows();
  log('info', 'finished', `${JOB_NAME} done`, {
    groups_collapsed: groupsCollapsed,
    rows_killed: rowsKilled,
    active_rows_before: activeBefore,
    active_rows_after: activeAfter,
    elapsed: formatDuration(elapsedMs),
    elapsed_ms: elapsedMs,
  });

  return {
    groupsCollapsed,
    rowsKilled,
    rowsRemainingActive: activeAfter,
  };
};

const main = async () => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    await runDedupe();
  } catch (error) {
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: (error as Error).message });
    captureError(error, 'failed');
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
};

void main();

// Production entry point is the `main()` invocation above; tests reach into
// the individual primitives via the named exports.
export { main, JOB_NAME };
