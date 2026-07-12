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
    if (totals.upserts_total === 0) {
      throw new Error(`venue-events-fixture-run: 0 concerts upserted (totals=${JSON.stringify(totals)})`);
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
