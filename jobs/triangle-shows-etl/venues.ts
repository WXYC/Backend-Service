/**
 * Venue partition for triangle-shows-etl (BS#1570 Decision 1).
 *
 * The RHP venue-events-scraper owns 5 Triangle venues first-party; this
 * ETL ingests everything else triangle-shows covers. The exclusion list
 * is asserted against the live source venue list at every run start so
 * drift fails the run loudly instead of silently double-ingesting a
 * venue (duplicate concerts under two sources) or dropping one.
 *
 * Slug-mapping note for the future supersession checkpoint, not this
 * job: BS seeds Motorco as `motorco-music-hall`; triangle-shows uses
 * `motorco`. If a slug ever moves off this list, its BS venue row must
 * be reconciled with the RHP seed first.
 */
import type { TriangleShowsVenue } from './map.js';

/** The 5 double-covered slugs that stay on the RHP scraper. */
export const EXCLUDED_VENUE_SLUGS = [
  'cats-cradle',
  'cats-cradle-back-room',
  'local-506',
  'motorco',
  'haw-river-ballroom',
] as const;

const EXCLUDED_SET: ReadonlySet<string> = new Set(EXCLUDED_VENUE_SLUGS);

/** Single membership predicate for the partition — the orchestrator and
 *  partitionVenues must never encode "excluded" two different ways. */
export const isExcludedSlug = (slug: string): boolean => EXCLUDED_SET.has(slug);

/** venues.slug is varchar(64); a longer source slug must fail loudly
 *  rather than truncate into a colliding key. */
const MAX_SLUG_LENGTH = 64;

/** venues.name is varchar(128) but the source allows String(200); an
 *  unguarded bind would abort the whole run as a raw PG 22001 during
 *  venue provisioning. Same fail-loudly policy as the RHP scraper's
 *  MAX_VENUE_NAME_LEN check in parse.ts. */
const MAX_NAME_LENGTH = 128;

/**
 * Validate the source venue set and return the venues this ETL ingests.
 *
 * Throws (run-fatal) when:
 *  (a) any excluded slug no longer exists at the source — the partition
 *      was decided against a specific venue set, so drift needs a human
 *      to re-audit which scraper owns the room;
 *  (b) any ingested slug exceeds venues.slug varchar(64).
 *
 * A NEW unexcluded slug is not drift — new rooms flow straight in.
 */
export const partitionVenues = (sourceVenues: TriangleShowsVenue[]): TriangleShowsVenue[] => {
  const sourceSlugs = new Set(sourceVenues.map((v) => v.slug));
  const missing = EXCLUDED_VENUE_SLUGS.filter((slug) => !sourceSlugs.has(slug));
  if (missing.length > 0) {
    throw new Error(
      `venue partition drift: excluded slug(s) [${missing.join(', ')}] no longer exist in the ` +
        `triangle-shows venue list. Re-audit the BS#1570 Decision 1 partition before ingesting.`
    );
  }

  const ingested = sourceVenues.filter((v) => !isExcludedSlug(v.slug));

  const oversized = ingested.filter((v) => v.slug.length > MAX_SLUG_LENGTH);
  if (oversized.length > 0) {
    throw new Error(
      `venue slug(s) [${oversized.map((v) => v.slug).join(', ')}] exceed venues.slug varchar(${MAX_SLUG_LENGTH})`
    );
  }

  const overlongNames = ingested.filter((v) => v.name.length > MAX_NAME_LENGTH);
  if (overlongNames.length > 0) {
    throw new Error(
      `venue name(s) for slug(s) [${overlongNames.map((v) => v.slug).join(', ')}] exceed venues.name varchar(${MAX_NAME_LENGTH}); shorten at the triangle-shows source`
    );
  }

  return ingested;
};
