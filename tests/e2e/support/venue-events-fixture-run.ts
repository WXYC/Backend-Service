/**
 * E2E fixture driver for the venue-events-scraper (RHP) pipeline.
 *
 * Runs the REAL scraper orchestrator (`runScraper`) with the REAL parser
 * (`extractEventLinks` / `parseEventPage`) and the REAL DB writer
 * (`makeVenueCache` / `upsertConcert`) — only the network fetch is swapped
 * for a fixture-backed `fetchHtml` that serves the committed Cat's Cradle
 * HTML from `tests/fixtures/venue-events-scraper/`. That exercises the
 * parse → venue-upsert → concert-upsert chain against a real Postgres
 * exactly as production does, minus the live HTTP.
 *
 * Invoked as a child process by `tests/e2e/concerts-pipeline.test.ts` (same
 * pattern as `etl.test.ts` running the ETL jobs via `tsx`), so `@wxyc/database`
 * binds to whatever DB_* the parent passes in the env. Prints the run totals
 * as JSON on stdout and exits non-zero if the scraper's own run guards throw.
 *
 * This deliberately mirrors `job.ts`'s wiring but reaches the orchestrator
 * directly: `job.ts` fetches over the network, so it can't be pointed at
 * fixtures. Only the fetch seam is swapped — the parse, venue-upsert, and
 * concert-upsert code paths are the real ones. `job.ts`'s own concerns (env
 * parsing, the sites-all-failed / events-seen-but-zero-upserts run guards) are
 * covered by `tests/unit/jobs/venue-events-scraper/*`; this driver's job is the
 * data pipeline, not those guards.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeDatabaseConnection } from '@wxyc/database';
import { runScraper } from '../../../jobs/venue-events-scraper/orchestrate.js';
import { extractEventLinks, parseEventPage } from '../../../jobs/venue-events-scraper/parse.js';
import { makeVenueCache, upsertConcert } from '../../../jobs/venue-events-scraper/writer.js';
import { mapConcurrent } from '../../../jobs/venue-events-scraper/rhp-fetch.js';
import { RHP_SITES } from '../../../jobs/venue-events-scraper/rhp-venues.js';
import { initLogger, closeLogger } from '../../../jobs/venue-events-scraper/logger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../fixtures/venue-events-scraper');
const readFixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

// The events index links to three event slugs; each maps to a committed
// fixture. Names line up (aaron-lee-tasjan → "Aaron Lee Tasjan",
// sleater-kinney → "Sleater-Kinney", the-headliner → "The Headliner").
const INDEX_URL = 'https://catscradle.com/events/';
const EVENT_FIXTURES: Record<string, string> = {
  'https://catscradle.com/event/aaron-lee-tasjan-2/': 'cats-cradle-aaron-lee-tasjan.html',
  'https://catscradle.com/event/sleater-kinney/': 'cats-cradle-headliner-only.html',
  'https://catscradle.com/event/the-headliner/': 'cats-cradle-multi-support.html',
};

const fetchHtml = (url: string): Promise<string> => {
  if (url === INDEX_URL) return Promise.resolve(readFixture('cats-cradle-events-index.html'));
  const fixture = EVENT_FIXTURES[url];
  if (!fixture) return Promise.reject(new Error(`venue-events-fixture-run: no fixture mapped for ${url}`));
  return Promise.resolve(readFixture(fixture));
};

const catsCradle = RHP_SITES.find((s) => s.site_slug === 'cats-cradle');
if (!catsCradle) throw new Error('venue-events-fixture-run: cats-cradle site config missing from RHP_SITES');

// Guard the EVENT_FIXTURES ↔ index-fixture coupling: if someone edits
// cats-cradle-events-index.html to add/rename a slug without updating the map,
// fail loudly here instead of letting the unmapped URL become a swallowed
// fetch_error deep in the orchestrator.
const EXPECTED_EVENTS = Object.keys(EVENT_FIXTURES).length;
const indexLinks = extractEventLinks(readFixture('cats-cradle-events-index.html'), catsCradle.base_url);
const unmapped = indexLinks.filter((url) => !(url in EVENT_FIXTURES));
if (unmapped.length > 0) {
  throw new Error(`venue-events-fixture-run: index fixture links have no mapped fixture: ${unmapped.join(', ')}`);
}
if (indexLinks.length !== EXPECTED_EVENTS) {
  throw new Error(
    `venue-events-fixture-run: index fixture links (${indexLinks.length}) != mapped fixtures (${EXPECTED_EVENTS}); update EVENT_FIXTURES`
  );
}

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: 'venue-events-fixture-run' });
  const venueCache = makeVenueCache();
  try {
    const totals = await runScraper({
      sites: [catsCradle],
      concurrency: 4,
      fetchHtml,
      extractEventLinks,
      parseEventPage,
      resolveVenueId: (slug, name, addr) => venueCache.get(slug, name, addr),
      upsertConcert,
      mapConcurrent,
    });
    // Every mapped fixture must upsert — not merely "at least one" — so a
    // JSON-LD drift that drops one event is caught here, not one layer up.
    if (totals.upserts_total !== EXPECTED_EVENTS) {
      throw new Error(
        `venue-events-fixture-run: expected ${EXPECTED_EVENTS} upserts, got ${totals.upserts_total} (totals=${JSON.stringify(totals)})`
      );
    }
    process.stdout.write(`${JSON.stringify(totals)}\n`);
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
};

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack || String(error)}\n`);
  process.exitCode = 1;
});
