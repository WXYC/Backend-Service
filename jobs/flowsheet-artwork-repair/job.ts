/**
 * BS#1209 drain entrypoint. Operator contract + run procedure live in
 * `README.md`; the run is gated on the LML#409 deploy clearing the ≥ 90%
 * `enriched_match → non-null artwork_url` rate from Sentry trace explorer.
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
