/**
 * Entrypoint for jobs/library-discogs-unavailable-recheck (BS#1283 / epic
 * #1280 sub-issue 3).
 *
 * Daily cron that rechecks `library` rows the MD flagged
 * `discogs_unavailable`. Two classes of flagged release need different
 * recovery behavior: audience-segment releases (never on Discogs — permanent
 * skip is correct) and embargoed promos (eventually clear Discogs). Without
 * this recheck the flag stays set forever and an embargoed promo never gets
 * enriched after Discogs catches up. See `orchestrate.ts`'s module doc for
 * the full design rationale (0.95 confidence floor, sticky-false-match fix).
 *
 * Schedule: `0 6 * * *` UTC daily, per this package's `cron-schedule` field
 * (resolved by `scripts/resolve-cron-schedule.sh`, wired into
 * `.github/workflows/deploy-base.yml`'s crontab-install step). Classified as
 * a light-touch LML-hitting cron in `docs/ops-cron-scheduling.md` — bounded
 * by `LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_BATCH_SIZE`, per-row
 * `lookupMetadata` calls gated by this job's own limiter
 * (`lml-limiter.ts`) — not subject to the heavy-drain ≥60 min slot-spacing
 * rule.
 *
 * Invocation:
 *   docker run --rm --env-file .env <image>
 *
 * Required env: LIBRARY_METADATA_URL (LML host), LML_API_KEY (bearer),
 * DB_* (postgres connection).
 *
 * Optional env:
 *   LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_BATCH_SIZE       default 50
 *   LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_MAX_CONCURRENT   default 1
 *   LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_RATE_PER_MIN     default 20
 *   LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_LML_TIMEOUT_MS   default 8000
 */

import { closeDatabaseConnection, requirePositiveInt } from '@wxyc/database';

import { runRecheck } from './orchestrate.js';
import { loadCandidates, BATCH_SIZE_ENV, BATCH_SIZE_DEFAULT } from './query.js';
import { lookupRecheck } from './lml-fetch.js';
import { writeMatch, stampRecheckTimestamp } from './writer.js';
import { initLogger, log, captureError, captureCounter, closeLogger } from './logger.js';

const JOB_NAME = 'library-discogs-unavailable-recheck';

/** Sentry counter incremented when LML finds a match on a flagged release, but the match's confidence falls below the 0.95 floor — see `orchestrate.ts`'s module doc for why this never auto-writes. */
export const LOW_CONFIDENCE_METRIC = 'lml.lookup.recheck.match_found_on_flagged';

const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    requireLmlConfigured();
    const batchSize = requirePositiveInt(process.env[BATCH_SIZE_ENV], BATCH_SIZE_ENV, BATCH_SIZE_DEFAULT, {
      context: JOB_NAME,
    });
    log('info', 'init', `${JOB_NAME} initialized`, { batch_size: batchSize });

    const { totals } = await runRecheck({
      loadCandidates: () => loadCandidates(batchSize),
      lookup: lookupRecheck,
      writeMatch,
      stamp: stampRecheckTimestamp,
      recordLowConfidence: ({ libraryId, artistName, albumTitle, confidence }) => {
        captureCounter(LOW_CONFIDENCE_METRIC, 1, {
          confidence,
          artist_name: artistName,
          album_title: albumTitle,
          library_id: libraryId,
        });
        log('warn', 'low_confidence_match', 'LML found a sub-floor match for a flagged release', {
          library_id: libraryId,
          confidence,
        });
      },
    });

    log('info', 'finished', `${JOB_NAME} done`, totals);
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
