/**
 * Entry point for the venue-events-scraper job.
 *
 * Scrapes upcoming concerts from Rockhouse Partners-powered Triangle
 * venue sites (catscradle.com, local506.com — extensible via
 * `rhp-venues.ts`) by parsing schema.org `Event` JSON-LD from each event
 * detail page, then UPSERTs into the `concerts` table by
 * (source='rhp_scrape', source_id=event-page-path).
 *
 * Run procedure: cron-registered via deploy-base's `cron-schedule` from
 * package.json (`0 5 * * *` UTC = 01:00 ET overnight, before the LML
 * backfill window at 06:00 UTC). Container runs to completion or is
 * killed by the next deploy / manual `docker rm -f
 * venue-events-scraper-cron`.
 *
 * Operational tuning:
 *   - `VENUE_SCRAPER_CONCURRENCY` (default 8) caps in-flight per-event
 *     fetches per site. Set lower (e.g. 4) if a venue starts rate-
 *     limiting; higher (e.g. 16) once we add more sites and want a
 *     shorter wall-clock.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { runScraper } from './orchestrate.js';
import { fetchHtml, mapConcurrent } from './rhp-fetch.js';
import { extractEventLinks, parseEventPage } from './parse.js';
import { makeVenueCache, upsertConcert } from './writer.js';
import { RHP_SITES } from './rhp-venues.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'venue-events-scraper';

const parseConcurrency = (raw: string | undefined): number => {
  if (raw === undefined) return 8;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 32) {
    throw new Error(`VENUE_SCRAPER_CONCURRENCY must be an integer 1..32; got ${raw}`);
  }
  return n;
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    const concurrency = parseConcurrency(process.env.VENUE_SCRAPER_CONCURRENCY);
    log('info', 'init', `${JOB_NAME} initialized`, { concurrency, sites: RHP_SITES.length });

    const venueCache = makeVenueCache();

    const totals = await runScraper({
      sites: RHP_SITES,
      concurrency,
      fetchHtml,
      extractEventLinks,
      parseEventPage,
      resolveVenueId: (slug, name, addr) => venueCache.get(slug, name, addr),
      upsertConcert,
      mapConcurrent,
    });

    log('info', 'venue_cache_stats', 'venue cache size at end of run', {
      venues_cached: venueCache.size(),
    });

    if (totals.sites_succeeded === 0 && totals.sites_attempted > 0) {
      throw new Error('all sites failed at the index-fetch step; aborting with non-zero exit');
    }
    // Index fetches succeeded but every per-event step failed — without
    // this guard the job would exit 0 and cron-success monitoring would
    // stay green even though no fresh rows landed. Treat as a wholesale
    // failure when at least one site had events to process.
    if (totals.events_seen > 0 && totals.upserts_total === 0) {
      throw new Error(
        `${totals.events_seen} events discovered but 0 upserted ` +
          `(fetch_errors=${totals.fetch_errors}, parse_errors=${totals.parse_errors}, ` +
          `pages_without_event_block=${totals.pages_without_event_block}, ` +
          `venue_resolve_errors=${totals.venue_resolve_errors}, upsert_errors=${totals.upsert_errors}); ` +
          `aborting with non-zero exit`
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
