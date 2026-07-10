/**
 * Entry point for the triangle-shows-etl job (BS#1589, Phase 1 of the
 * BS#1570 touring-events integration).
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
 * package.json (`5 5 * * *` UTC = 01:05 ET, between the RHP scraper at
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

    const totals = await runEtl({
      fetchHealth: () => fetchHealth(baseUrl),
      fetchVenues: () => fetchVenues(baseUrl),
      fetchEvents: (start) => fetchEvents(baseUrl, start),
      resolveVenueId: (slug, name, city) => venueCache.get(slug, name, city),
      upsertConcert,
    });

    // Mirror the RHP scraper's zero-work guard: events came back but
    // nothing landed — exit non-zero so cron-success monitoring can't
    // stay green through a wholesale write-path failure.
    const eventsIngestable = totals.events_seen - totals.events_excluded;
    if (eventsIngestable > 0 && totals.upserts_total === 0) {
      throw new Error(
        `${eventsIngestable} ingestable events pulled but 0 upserted ` +
          `(map_errors=${totals.map_errors}, venue_resolve_errors=${totals.venue_resolve_errors}, ` +
          `upsert_errors=${totals.upsert_errors}); aborting with non-zero exit`
      );
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
