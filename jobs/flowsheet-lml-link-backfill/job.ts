/**
 * One-shot backfill: link unlinked flowsheet rows to library via LML's
 * canonical-entity lookup (B-2.2).
 *
 * Targets the ~1.18M flowsheet rows where `album_id IS NULL`:
 *   - 889K never had a `legacy_release_id` (manual DJ entries).
 *   - ~290K had a `legacy_release_id` whose FK didn't resolve, stamped by
 *     B-0.5's broken-FK recovery (`legacy_link_attempted_at IS NOT NULL`).
 *
 * For each row the job calls `LML.lookupMetadata(artist, album)`, picks the
 * direct-hit canonical entity (B-0 calibration), and links to a single
 * library row when one exists with that `canonical_entity_id`. See
 * `orchestrate.ts` for the loop and `resolve.ts` for the per-signal contract.
 *
 * Cross-run resumability is via the WHERE filter alone: linked rows fall
 * out (`album_id IS NULL` no longer matches); review / no_match / error /
 * no_library_match rows stay in the pool and roll forward to the next sweep.
 *
 * Run procedure: build via `Manual Build & Deploy` with
 * `target=flowsheet-lml-link-backfill`, then SSH to EC2 and
 * `docker run --rm --env-file .env <image> 2>&1 | tee log`. The job runs
 * during a low-traffic window — LML's rate budget is the limiting factor,
 * not the database.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runBackfill } from './orchestrate.js';
import { lookupMetadata } from './lml-fetch.js';

const JOB_NAME = 'flowsheet-lml-link-backfill';

const main = async () => {
  try {
    await runBackfill({ lookup: lookupMetadata });
  } finally {
    await closeDatabaseConnection();
  }
};

main().catch((error) => {
  console.error(`[${JOB_NAME}] Failed:`, error);
  process.exitCode = 1;
});
