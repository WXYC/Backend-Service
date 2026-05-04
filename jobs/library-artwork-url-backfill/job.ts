/**
 * One-shot warm of `library.artwork_url` for Discogs-resolvable rows (#637).
 *
 * Iterates every `library` row joined to `artists` where `artwork_url IS NULL`
 * and `a.discogs_artist_id IS NOT NULL`, calls LML's /lookup for each one,
 * and writes the artwork URL back via `applyEnrichment`. Cross-run
 * resumability is via the WHERE filter alone — successful rows have non-null
 * `artwork_url`; LML-throw and no-match rows stay NULL.
 *
 * Run procedure: see Backend-Service/CLAUDE.md and issue #637. Build via
 * `Manual Build & Deploy` with `target=library-artwork-url-backfill`, then
 * SSH to EC2 and `docker run --rm --env-file .env <image> 2>&1 | tee log`.
 *
 * The ~18,500-row resolvable set finishes in well under an hour at default
 * throttle. Operators can run multiple containers via `PARTITION_COUNT`/
 * `PARTITION_INDEX` if wall time matters.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runBackfill } from './orchestrate.js';
import { lookupMetadata } from './lml-fetch.js';
import { applyEnrichment } from './enrich.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'library-artwork-url-backfill';

/**
 * Fail-fast on missing LML configuration. Without this, every row's
 * `lookupMetadata` call would throw at `baseUrl()` and the orchestrator would
 * generate ~18,500 `lml_error` events before an operator notices. Better to
 * exit 1 immediately with a clear message — same posture as the
 * flowsheet-metadata-backfill entrypoint.
 */
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
    await runBackfill({ lookup: lookupMetadata, enrich: applyEnrichment });
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
