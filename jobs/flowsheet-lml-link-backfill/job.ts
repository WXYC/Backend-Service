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

import * as Sentry from '@sentry/node';
import { closeDatabaseConnection } from '@wxyc/database';
import { runBackfill, type LinkageMetricName, type MetricsSink } from './orchestrate.js';
import { lookupMetadata } from './lml-fetch.js';

const JOB_NAME = 'flowsheet-lml-link-backfill';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  release: process.env.SENTRY_RELEASE,
  environment: process.env.NODE_ENV || 'production',
});

/**
 * Production metrics sink for the backfill job (B-3.2). The orchestrator's
 * per-batch `Totals` log already gives the operator a per-run scoreboard;
 * this sink ships per-row counters under the canonical observability names
 * shared with the forward path, plus Sentry tagging on every LML failure
 * (`subsystem='lml-linkage'`, `path='backfill'`).
 */
const counters: Record<LinkageMetricName, number> = {
  linked_high_conf: 0,
  gray_zone_review: 0,
  no_candidate: 0,
  lml_error: 0,
  lml_timeout: 0,
};

const metrics: MetricsSink = {
  recordOutcome(name) {
    counters[name] += 1;
  },
  reportError(error, context) {
    Sentry.captureException(error, {
      tags: { subsystem: 'lml-linkage', path: 'backfill' },
      extra: context,
    });
  },
};

const main = async () => {
  try {
    await runBackfill({ lookup: lookupMetadata, metrics });
    console.log(`[${JOB_NAME}] linkage counters:`, counters);
  } finally {
    await closeDatabaseConnection();
    await Sentry.close(2000);
  }
};

main().catch((error) => {
  console.error(`[${JOB_NAME}] Failed:`, error);
  Sentry.captureException(error, { tags: { subsystem: 'lml-linkage', path: 'backfill' } });
  process.exitCode = 1;
});
