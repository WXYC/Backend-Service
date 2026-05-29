/**
 * One-shot drain entrypoint (BS#1209): repair LML artwork for the two
 * populations stranded by LML#408 (fixed in LML#409, deployed prod 2026-05-29).
 *
 * Run procedure: built as a Docker image and registered via the deploy
 * pipeline's `job-type=one-shot` pathway. Drain is gated on the LML#409
 * deploy clearing the ≥ 90 % `enriched_match → non-null artwork_url`
 * floor — verify via Sentry trace explorer (`enrichment.consumer.tick`
 * attributes) before launching.
 *
 * Failure isolation: any LML throw is counted as `error` and skipped; the
 * row stays in its eligible state so a subsequent run retries it.
 * Idempotent — the race-guarded WHERE clauses in `repair.ts` make re-runs
 * safe in any order.
 *
 * `metadata_status` is read-only across this entire job. After one full
 * run the residue should drop to the LML-true-no-match floor; the
 * `still_null_after_lml` counter feeds the LML#400 follow-up backfill.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runRepair } from './orchestrate.js';
import { lookupMetadata } from './lml-fetch.js';
import { repairFreeFormRow, repairLinkedAlbum } from './repair.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'flowsheet-artwork-repair';

const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
};

const main = async () => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    requireLmlConfigured();
    log('info', 'init', `${JOB_NAME} initialized`);
    await runRepair({
      lookup: lookupMetadata,
      repairFreeForm: repairFreeFormRow,
      repairLinked: repairLinkedAlbum,
    });
  } catch (error) {
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: (error as Error).message });
    captureError(error, 'failed');
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
};

// Guard the auto-invoke so the unit suite's module load doesn't fire a stray
// run against the mocked DB. Mirrors `jobs/album-level-backfill/job.ts`.
if (process.env.NODE_ENV !== 'test') {
  void main();
}
