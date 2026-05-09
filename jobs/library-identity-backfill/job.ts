/**
 * One-shot backfill entrypoint: populates `library_identity` +
 * `library_identity_source` from one of the §4 step 2 source legs.
 *
 * Dispatches by `BACKFILL_LEG` env var:
 *
 *   - `S1` (default): Backend `library.canonical_entity_id` → discogs_release
 *     per-source rows. Sub-PR 2.0.
 *   - `S2`: Backend `artists.{discogs_artist_id, ...}` (mirrored from LML by
 *     `jobs/artist-identity-etl/`) → six per-source rows per matched library
 *     row, with `(method, confidence)` looked up from LML's
 *     `entity.reconciliation_log` provenance index built at job start.
 *     Sub-PR 2.1.
 *
 * Future legs (2.2a, 2.2b, 2.3) extend this enum.
 *
 * Run procedure: build via `Manual Build & Deploy` with
 * `target=library-identity-backfill`, then SSH to EC2 and
 * `docker run --rm --env-file .env -e BACKFILL_LEG=S2 <image> 2>&1 | tee log`.
 * The job is resumable; rerunning is safe per the per-leg idempotency rules.
 *
 * DRY_RUN: set `DRY_RUN=true` to run without writing — the JSON report on
 * stdout details scanned/would-write/skipped counts. See `docs/env-vars.md`
 * and the package README for the locked schema (per-leg shape).
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runBackfill } from './orchestrate.js';
import { runBackfillS2 } from './orchestrate-s2.js';
import { writeIdentity } from './writer.js';
import { loadProvenanceIndex } from './sources/lml-provenance-index.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';
import { resolveBackfillLeg } from './dispatch.js';

const JOB_NAME = 'library-identity-backfill';

const main = async () => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    const leg = resolveBackfillLeg();
    log('info', 'init', `${JOB_NAME} initialized`, { leg });

    if (leg === 'S1') {
      await runBackfill({ writeIdentity });
    } else {
      const provenanceIndex = await loadProvenanceIndex();
      log('info', 'provenance_loaded', `LML provenance index loaded`, {
        leg: 'S2',
        size: provenanceIndex.size,
      });
      await runBackfillS2({ writeIdentity, provenanceIndex });
    }
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
