/**
 * Entry point for the triangle-shows-etl job (BS#1589).
 *
 * Nightly pull ETL: mirrors the triangle-shows concert calendar
 * (https://github.com/WXYC/triangle-shows) into `venues`/`concerts` for
 * the 16 Triangle venues the RHP venue-events-scraper doesn't cover,
 * keyed on (source='triangle_shows', source_id='<venue_slug>:' +
 * source_key) so re-runs UPSERT in place. The 5 double-covered slugs
 * stay on the RHP scraper (see `venues.ts`).
 *
 * Run procedure: cron-registered via deploy-base's `cron-schedule` from
 * package.json (`5 5 * * *` UTC = 01:05 ET — after the venue-events-
 * scraper at 05:00, before the concerts-artist-resolver at 05:15, so new
 * rows get artist-resolved the same night). Full snapshot every run, no
 * incremental cursor — idempotent by construction.
 *
 * Env: `TRIANGLE_SHOWS_URL` (required) — base URL of the triangle-shows
 * API. See docs/env-vars.md.
 */

import { closeDatabaseConnection } from '@wxyc/database';
import { buildEventsUrl, buildHealthUrl, buildVenuesUrl, fetchJson } from './fetch.js';
import { runEtl } from './orchestrate.js';
import { ensureVenue, upsertConcert } from './writer.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';
import type { TriangleShowsEvent, TriangleShowsVenue } from './map.js';

const JOB_NAME = 'triangle-shows-etl';

/** ~7h-old data at the 05:05 UTC pull is normal (the source's scheduler
 *  scrapes at 06:00/18:00 ET); >24h means the source's own scrapes have
 *  stopped and this mirror is re-serving stale data. */
const STALE_SCRAPE_MS = 24 * 60 * 60 * 1000;

type TriangleShowsHealth = {
  status: string;
  event_count: number;
  venue_count: number;
  last_scrape: string | null;
};

const requireBaseUrl = (): string => {
  const raw = process.env.TRIANGLE_SHOWS_URL;
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'TRIANGLE_SHOWS_URL is required (e.g. https://triangle-shows-production.up.railway.app); see docs/env-vars.md'
    );
  }
  return raw.trim();
};

/** Warn loudly on a stale source. Never fatal: the pull itself decides
 *  whether the run fails — a health blip shouldn't skip a good snapshot. */
const checkSourceFreshness = async (baseUrl: string): Promise<void> => {
  try {
    const health = await fetchJson<TriangleShowsHealth>(buildHealthUrl(baseUrl));
    const lastScrape = health.last_scrape ? new Date(health.last_scrape) : null;
    const ageMs = lastScrape === null ? null : Date.now() - lastScrape.getTime();
    // NaN (unparseable last_scrape after a serialization change) must warn,
    // not slip past both comparisons into the healthy branch.
    if (ageMs === null || Number.isNaN(ageMs) || ageMs > STALE_SCRAPE_MS) {
      const reason = ageMs === null ? 'absent' : Number.isNaN(ageMs) ? 'unparseable' : 'over 24h old';
      log('warn', 'source_stale', `triangle-shows last_scrape is ${reason}`, {
        last_scrape: health.last_scrape,
        age_ms: ageMs,
        source_status: health.status,
      });
      captureError(
        new Error(`triangle-shows source stale: last_scrape=${health.last_scrape ?? 'null'}`),
        'source_stale'
      );
    } else {
      log('info', 'source_health', 'triangle-shows source healthy', {
        last_scrape: health.last_scrape,
        age_ms: ageMs,
        source_event_count: health.event_count,
        source_venue_count: health.venue_count,
      });
    }
  } catch (error) {
    log('warn', 'health_check_failed', 'could not read triangle-shows /api/v1/health', {
      error_message: (error as Error).message,
    });
    captureError(error, 'health_check_failed');
  }
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  try {
    const baseUrl = requireBaseUrl();
    log('info', 'init', `${JOB_NAME} initialized`, { base_url: baseUrl });

    await checkSourceFreshness(baseUrl);

    // Independent pulls — venues and events share no data dependency.
    const [venues, events] = await Promise.all([
      fetchJson<TriangleShowsVenue[]>(buildVenuesUrl(baseUrl)),
      fetchJson<TriangleShowsEvent[]>(buildEventsUrl(baseUrl, new Date())),
    ]);

    // An empty snapshot is never legitimate: the window is today−8d with
    // no end bound across every source venue, the source holds its whole
    // upcoming calendar in-window, and even a fresh deployment
    // self-populates on startup. Zero events means a wiped source DB, a
    // wrong deployment behind TRIANGLE_SHOWS_URL, or a window-param
    // regression — exiting 0 here would leave cron monitoring green while
    // status/removed_at/scraped_at silently stop refreshing.
    if (events.length === 0) {
      throw new Error(
        `0 events returned from ${baseUrl} (start=today−8d, no end bound) — refusing to treat an empty snapshot as success`
      );
    }

    const totals = await runEtl({
      venues,
      events,
      resolveVenueId: (slug, name, city) => ensureVenue(slug, name, city),
      upsertConcert,
    });

    // Events arrived but nothing landed — without this guard the job
    // would exit 0 and cron-success monitoring would stay green even
    // though no fresh rows landed (same guard as venue-events-scraper).
    const nonExcluded = totals.events_seen - totals.events_excluded;
    if (nonExcluded > 0 && totals.upserts_total === 0) {
      throw new Error(
        `${nonExcluded} ingestable events pulled but 0 upserted ` +
          `(unknown_venue_errors=${totals.unknown_venue_errors}, map_errors=${totals.map_errors}, ` +
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
