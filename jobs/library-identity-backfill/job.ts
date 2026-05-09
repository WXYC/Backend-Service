/**
 * One-shot backfill: populate `library_identity` + `library_identity_source`
 * from Backend's `library.canonical_entity_id` (S1) — sub-PR 2.0 of §4 step 2.
 *
 * Iterates every `library` row whose `canonical_entity_id` matches
 * `'discogs:<release_id>'` and that is not yet present in `library_identity`.
 * For each row, writes one per-source `library_identity_source` (source =
 * 'discogs_release', method = 'exact_match', confidence = 1.00) and the
 * corresponding `library_identity` main row, atomically inside a single
 * `db.transaction()`.
 *
 * Run procedure: build via `Manual Build & Deploy` with
 * `target=library-identity-backfill`, then SSH to EC2 and
 * `docker run --rm --env-file .env <image> 2>&1 | tee log`. The job is
 * resumable; rerunning is safe (idempotent via the WHERE filter).
 *
 * DRY_RUN: set `DRY_RUN=true` to run the job without writing — the JSON
 * report on stdout details scanned/would-write/skipped counts. See
 * `docs/env-vars.md` and the package README for the locked schema.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runBackfill } from './orchestrate.js';
import { writeIdentity } from './writer.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'library-identity-backfill';

const main = async () => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    log('info', 'init', `${JOB_NAME} initialized`);
    await runBackfill({ writeIdentity });
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
