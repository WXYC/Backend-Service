/**
 * Entry point for the triangle-shows-etl job (BS#1589, Phase 1 of the
 * BS#1570 on-tour integration).
 *
 * Nightly full-snapshot pull from the triangle-shows concert calendar's
 * neutral `/api/v1/events` surface, mirrored into `venues`/`concerts` for
 * the 16 Triangle venues the RHP venue-events-scraper doesn't cover
 * (partition by venue — BS#1570 Decision 1). Keyed on
 * (source='triangle_shows', source_id='<venue_slug>:'+source_key) so
 * re-runs UPSERT in place. The concerts-artist-resolver picks the new
 * rows up in the same nightly cycle with no changes (its claim query has
 * no source filter).
 *
 * Run procedure: cron-registered via deploy-base's `cron-schedule` from
 * package.json (`5 5 * * *` UTC = 01:05 EDT / 00:05 EST, between the RHP scraper at
 * 05:00 and the resolver at 05:15). Container runs to completion.
 *
 * Required env: `TRIANGLE_SHOWS_URL` (see docs/env-vars.md).
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runEtl } from './orchestrate.js';
import { fetchEvents, fetchHealth, fetchVenues, resolveBaseUrl } from './fetch.js';
import { makeVenueCache, upsertConcert } from './writer.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'triangle-shows-etl';

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    const baseUrl = resolveBaseUrl();
    log('info', 'init', `${JOB_NAME} initialized`, { base_url: baseUrl });

    const venueCache = makeVenueCache();

    // Run guards (empty snapshot, zero upserts, majority failure) live in
    // runEtl so orchestrate.test.ts can exercise them — a thrown guard
    // lands in the catch below and exits non-zero.
    const totals = await runEtl({
      fetchHealth: () => fetchHealth(baseUrl),
      fetchVenues: () => fetchVenues(baseUrl),
      fetchEvents: (start) => fetchEvents(baseUrl, start),
      resolveVenueId: (slug, name, city) => venueCache.get(slug, name, city),
      upsertConcert,
    });

    log('info', 'venue_cache_stats', 'venue cache size at end of run', {
      venues_cached: venueCache.size(),
      upserts_total: totals.upserts_total,
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

void main();
