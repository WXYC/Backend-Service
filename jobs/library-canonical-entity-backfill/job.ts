/**
 * One-shot backfill: populate library.canonical_entity_id via LML (B-1.2).
 *
 * Iterates every `library` row where (canonical_entity_id IS NULL AND
 * canonical_entity_resolved_at IS NULL), calls LML's lookup endpoint with
 * (artist_name, album_title), and writes the resolved canonical entity.
 * Cross-run resumability is via the WHERE filter alone — successful rows
 * have both columns set, review-flagged rows have resolved_at, retryable
 * rows have neither.
 *
 * Run procedure: build via `Manual Build & Deploy` with
 * `target=library-canonical-entity-backfill`, then SSH to EC2 and
 * `docker run --rm --env-file .env <image> 2>&1 | tee log`. The job runs
 * during a low-traffic window — LML's rate budget is the limiting factor,
 * not the database.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runBackfill } from './orchestrate.js';
import { lookupMetadata } from './lml-fetch.js';

const JOB_NAME = 'library-canonical-entity-backfill';

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
