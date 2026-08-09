/**
 * Legacy linkage resolve: link `flowsheet` / `rotation` rows to their library
 * album once the library row exists.
 *
 * Both writer paths resolve `album_id` exactly once, at write time, against
 * whatever `library` held at that instant:
 *
 *   - `/internal/flowsheet-webhook` resolves on INSERT and deliberately never
 *     refreshes on conflict — "linkage is anchored to the first delivery"
 *     (apps/backend/routes/internal.route.ts).
 *   - `/internal/rotation-webhook` resolves once via `resolveAlbumId(rawLibraryId)`.
 *
 * That is a race against `jobs/library-etl/`, which imports the catalog on its
 * own half-hourly schedule, and against the librarian, who routinely files the
 * physical release *after* the MD bins it. Any row whose library row lands
 * second keeps `album_id = NULL` forever unless something re-runs the join.
 *
 * Until Phase 3 of the tubafrenzy decommission that "something" was a tail
 * pass inside `jobs/flowsheet-etl/` and `jobs/rotation-etl/`, which ran every
 * 30 minutes. Those jobs were unscheduled when Backend became canonical
 * (WXYC/wiki#88) because their *import* half now writes backwards — from
 * tubafrenzy's mirror copy onto Backend-canonical rows. Their repair half has
 * no such problem: it reads and writes only Backend's own tables and never
 * contacts tubafrenzy. This job is that repair half, lifted out verbatim so it
 * survives the import's retirement.
 *
 * Both statements are anti-joined on `album_id IS NULL`, so a run with nothing
 * to fix is a no-op and re-running is idempotent. No cooperative live-DJ pause:
 * the candidate set is bounded by the rows a webhook could not link, the writes
 * are narrow, and deferring the repair indefinitely during a long show is worse
 * than the contention it would avoid.
 *
 * Usage:
 *   node dist/job.js              # resolve (default)
 *   node dist/job.js --dry-run    # report candidate counts, write nothing
 */

import { sql } from 'drizzle-orm';
import { db, flowsheet, rotation, library, closeDatabaseConnection } from '@wxyc/database';
import { initLogger, log, captureError, errorMessage, closeLogger } from './logger.js';

const JOB_NAME = 'legacy-linkage-resolve';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');

export type PassResult = { candidates: number; resolved: number };
export type RunResult = { flowsheet: PassResult; rotation: PassResult };

/**
 * Link `flowsheet.album_id` by joining `legacy_release_id` to
 * `library.legacy_release_id`. Lifted verbatim from `jobs/flowsheet-etl/`'s
 * `resolveAlbumIds`.
 *
 * `updated_at` is deliberately not set — migration 0084's trigger owns that
 * column on `flowsheet`.
 */
const resolveFlowsheetAlbumIds = async (dryRun: boolean): Promise<PassResult> => {
  const [row] = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM ${flowsheet} f
    JOIN ${library} l ON f.legacy_release_id = l.legacy_release_id
    WHERE f.legacy_release_id IS NOT NULL
      AND f.album_id IS NULL
  `)) as unknown as Array<{ count: number | string }>;
  const candidates = Number(row?.count ?? 0);

  if (dryRun || candidates === 0) {
    return { candidates, resolved: 0 };
  }

  const result = await db.execute(sql`
    UPDATE ${flowsheet} f
    SET album_id = l.id
    FROM ${library} l
    WHERE f.legacy_release_id = l.legacy_release_id
      AND f.legacy_release_id IS NOT NULL
      AND f.album_id IS NULL
  `);
  const resolved = Number(result.count ?? 0);

  if (resolved > 0) {
    await db.execute(sql.raw(`ANALYZE "${SCHEMA}"."flowsheet"`));
  }
  return { candidates, resolved };
};

/**
 * Link `rotation.album_id` by joining `legacy_library_release_id` to
 * `library.legacy_release_id`, clearing the denormalized display columns the
 * row carried while it was unlinked. Lifted verbatim from
 * `jobs/rotation-etl/`'s `resolveAlbumIds`.
 */
const resolveRotationAlbumIds = async (dryRun: boolean): Promise<PassResult> => {
  const [row] = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM ${rotation} r
    JOIN ${library} l ON r.legacy_library_release_id = l.legacy_release_id
    WHERE r.legacy_library_release_id IS NOT NULL
      AND r.album_id IS NULL
  `)) as unknown as Array<{ count: number | string }>;
  const candidates = Number(row?.count ?? 0);

  if (dryRun || candidates === 0) {
    return { candidates, resolved: 0 };
  }

  const result = await db.execute(sql`
    UPDATE ${rotation} r
    SET album_id = l.id,
        artist_name = NULL,
        album_title = NULL,
        record_label = NULL
    FROM ${library} l
    WHERE r.legacy_library_release_id = l.legacy_release_id
      AND r.legacy_library_release_id IS NOT NULL
      AND r.album_id IS NULL
  `);
  const resolved = Number(result.count ?? 0);

  if (resolved > 0) {
    await db.execute(sql.raw(`ANALYZE "${SCHEMA}"."rotation"`));
  }
  return { candidates, resolved };
};

export const runResolve = async (dryRun: boolean): Promise<RunResult> => {
  const flowsheetResult = await resolveFlowsheetAlbumIds(dryRun);
  log('info', 'resolve-flowsheet', 'Flowsheet linkage pass complete.', {
    dry_run: dryRun,
    candidates: flowsheetResult.candidates,
    resolved: flowsheetResult.resolved,
  });

  const rotationResult = await resolveRotationAlbumIds(dryRun);
  log('info', 'resolve-rotation', 'Rotation linkage pass complete.', {
    dry_run: dryRun,
    candidates: rotationResult.candidates,
    resolved: rotationResult.resolved,
  });

  return { flowsheet: flowsheetResult, rotation: rotationResult };
};

// ---- Main ----

const run = async () => {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  log('info', 'start', dryRun ? 'Starting linkage resolve (dry run).' : 'Starting linkage resolve.', {
    dry_run: dryRun,
  });

  let exitCode = 0;
  try {
    const result = await runResolve(dryRun);
    log('info', 'complete', 'Linkage resolve complete.', {
      dry_run: dryRun,
      flowsheet_resolved: result.flowsheet.resolved,
      rotation_resolved: result.rotation.resolved,
    });
  } catch (error) {
    exitCode = 1;
    log('error', 'failed', 'Linkage resolve failed.', { error: errorMessage(error) });
    captureError(error, 'failed');
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
  process.exit(exitCode);
};

// `run` catches everything internally and exits with its own code, so there is
// no rejection to handle here.
void run();
