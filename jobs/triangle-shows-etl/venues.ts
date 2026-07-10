/**
 * Venue partition (BS#1570 Decision 1: partition by venue). The RHP
 * `venue-events-scraper` keeps its 5 rooms; this ETL ingests everything
 * else triangle-shows covers. Running both against the same venue would
 * double-scrape and manufacture guaranteed cross-source duplicates, so
 * the 5 double-covered slugs are excluded here — their events are
 * skipped and they never get an ETL-provisioned `venues` row.
 *
 * Slugs are TRIANGLE-SHOWS slugs. Supersession-checkpoint footnote (not
 * this job's problem): BS's own venue seed spells Motorco
 * `motorco-music-hall` while triangle-shows uses `motorco` — flipping a
 * venue from RHP to triangle-shows later must map the slug or it will
 * provision a duplicate Motorco venue row.
 */

import type { TsVenue } from './types.js';

export const EXCLUDED_VENUE_SLUGS: readonly string[] = [
  'cats-cradle',
  'cats-cradle-back-room',
  'local-506',
  'motorco',
  'haw-river-ballroom',
];

const excludedSet = new Set(EXCLUDED_VENUE_SLUGS);

export const isExcluded = (slug: string): boolean => excludedSet.has(slug);

/** `venues.slug` is varchar(64); PG errors rather than truncates. */
const VENUE_SLUG_MAX = 64;

/**
 * Startup assertions against the source's venue list; both fail the run
 * loudly rather than degrade silently:
 *
 *  (a) all 5 excluded slugs still exist at the source — if triangle-shows
 *      renames or drops one, the partition premise has drifted and a human
 *      must re-check the double-coverage set before the ETL runs again;
 *  (b) every INGESTED slug fits `venues.slug varchar(64)` — a source-side
 *      slug change past the column width would otherwise fail mid-run on
 *      the venue INSERT, after some rows already wrote.
 */
export const assertVenuePartition = (sourceVenues: readonly TsVenue[]): void => {
  const sourceSlugs = new Set(sourceVenues.map((v) => v.slug));

  const missingExcluded = EXCLUDED_VENUE_SLUGS.filter((slug) => !sourceSlugs.has(slug));
  if (missingExcluded.length > 0) {
    throw new Error(
      `assertVenuePartition: excluded slug(s) [${missingExcluded.join(', ')}] no longer exist in the ` +
        `triangle-shows venue list — the venue partition (BS#1570 Decision 1) has drifted; re-verify the ` +
        `RHP double-coverage set before running this ETL`
    );
  }

  const overlong = ingestedVenues(sourceVenues).filter((v) => v.slug.length > VENUE_SLUG_MAX);
  if (overlong.length > 0) {
    throw new Error(
      `assertVenuePartition: ingested venue slug(s) [${overlong.map((v) => v.slug).join(', ')}] exceed ` +
        `venues.slug varchar(${VENUE_SLUG_MAX})`
    );
  }
};

/** The venues this ETL owns: the source list minus the excluded 5. */
export const ingestedVenues = (sourceVenues: readonly TsVenue[]): TsVenue[] =>
  sourceVenues.filter((v) => !isExcluded(v.slug));
