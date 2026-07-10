/**
 * Orchestrator for triangle-shows-etl.
 *
 * Run shape (one pull, one pass — no per-site loop; the source is a
 * single API):
 *   1. Partition the source venue list (throws on drift — run-fatal).
 *   2. Provision every ingested venue's `venues` row up front, eventless
 *      venues included, building the source-venue-id → BS-venue-id map.
 *   3. Iterate the event snapshot: skip excluded venues, map, UPSERT.
 *
 * Dependencies (venue resolution, concert upsert) are injected so unit
 * tests drive the loop without network or DB; production wires them in
 * `job.ts`. Per-event errors are caught, counted, and Sentry-captured —
 * one bad event never wedges the run. Venue provisioning errors ARE
 * run-fatal: a broken venues table would otherwise silently drop every
 * event at that venue.
 */

import { mapEvent, type MappedConcert, type TriangleShowsEvent, type TriangleShowsVenue } from './map.js';
import { EXCLUDED_VENUE_SLUGS, isExcludedSlug, partitionVenues } from './venues.js';
import { captureError, log } from './logger.js';

const JOB_NAME = 'triangle-shows-etl';

export type ResolveVenueIdFn = (
  slug: string,
  name: string,
  city: string
) => Promise<{ venue_id: number; created: boolean }>;
export type UpsertConcertFn = (
  mapped: MappedConcert,
  venueId: number,
  scrapedAt: Date
) => Promise<{ concert_id: number; inserted: boolean }>;

export type Totals = {
  venues_provisioned: number;
  /** Venue rows INSERTed this run. 16 on the first run, 0 in steady
   *  state; nonzero afterwards means a genuinely new room OR an
   *  ingested-slug rename at the source — the latter permanently re-keys
   *  that venue's events, so audit before trusting the feed. */
  venues_created: number;
  events_seen: number;
  /** Events at the 5 double-covered venues the RHP scraper owns. */
  events_excluded: number;
  /** Events whose venue_id isn't in the source venue list at all —
   *  should be zero; non-zero means the source's events and venues
   *  endpoints disagree. */
  unknown_venue_errors: number;
  /** mapEvent threw (unmappable status, malformed date/time). */
  map_errors: number;
  upsert_errors: number;
  upserts_total: number;
  upserts_inserted: number;
  upserts_updated: number;
  /** Events carrying a source tombstone this pull (removed_at set). */
  events_tombstoned: number;
  /** Events whose composed starts_at is EARLIER than doors_at — the
   *  free-text scrapers can pair a past-midnight show_time with the
   *  advertised date. Logged and passed through unmodified: no heuristic
   *  can safely re-shift either timestamp (the inverse skew also exists,
   *  where starts_at is correct and doors_at is the misparse). */
  time_order_anomalies: number;
};

const emptyTotals = (): Totals => ({
  venues_provisioned: 0,
  venues_created: 0,
  events_seen: 0,
  events_excluded: 0,
  unknown_venue_errors: 0,
  map_errors: 0,
  upsert_errors: 0,
  upserts_total: 0,
  upserts_inserted: 0,
  upserts_updated: 0,
  events_tombstoned: 0,
  time_order_anomalies: 0,
});

export type RunOptions = {
  /** Full venue list from GET /api/v1/venues. */
  venues: TriangleShowsVenue[];
  /** Event snapshot from GET /api/v1/events (dedup=false, include_removed=true, back-dated start). */
  events: TriangleShowsEvent[];
  resolveVenueId: ResolveVenueIdFn;
  upsertConcert: UpsertConcertFn;
  /** Injectable for tests. Defaults to `() => new Date()` in production. */
  now?: () => Date;
};

export const runEtl = async (opts: RunOptions): Promise<Totals> => {
  const totals = emptyTotals();
  const now = opts.now ?? (() => new Date());

  const ingested = partitionVenues(opts.venues);
  log('info', 'started', `${JOB_NAME} starting`, {
    source_venues: opts.venues.length,
    ingested_venues: ingested.length,
    excluded_slugs: [...EXCLUDED_VENUE_SLUGS],
    events: opts.events.length,
  });

  // Provision up front — an ingested venue with zero events this window
  // still gets its row, so the venues table converges on the partition
  // rather than on whichever venues happened to have listings.
  const excludedSourceIds = new Set(opts.venues.filter((v) => isExcludedSlug(v.slug)).map((v) => v.id));
  const bySourceVenueId = new Map<number, { venue_id: number; slug: string }>();
  for (const venue of ingested) {
    const { venue_id, created } = await opts.resolveVenueId(venue.slug, venue.name, venue.city);
    bySourceVenueId.set(venue.id, { venue_id, slug: venue.slug });
    totals.venues_provisioned += 1;
    if (created) {
      totals.venues_created += 1;
      // Steady state is zero. A new room is fine; an ingested-slug RENAME
      // also lands here (new slug, familiar name) and permanently re-keys
      // that venue's events — the old rows never tombstone. Warn so the
      // finished-line reader audits which case this is.
      log(
        'warn',
        'venue_created',
        `created venues row for '${venue.slug}' — new room or slug rename? audit if unexpected`,
        {
          venue_slug: venue.slug,
          venue_name: venue.name,
        }
      );
    }
  }

  const scrapedAt = now();
  for (const event of opts.events) {
    totals.events_seen += 1;

    if (excludedSourceIds.has(event.venue_id)) {
      totals.events_excluded += 1;
      continue;
    }

    const target = bySourceVenueId.get(event.venue_id);
    if (target === undefined) {
      totals.unknown_venue_errors += 1;
      log('warn', 'unknown_venue', `event ${event.id} references venue_id ${event.venue_id} not in the venue list`, {
        event_id: event.id,
        source_venue_id: event.venue_id,
      });
      captureError(new Error(`event ${event.id} references unknown venue_id ${event.venue_id}`), 'unknown_venue');
      continue;
    }

    let mapped: MappedConcert;
    try {
      mapped = mapEvent(event, target.slug);
    } catch (error) {
      totals.map_errors += 1;
      log('warn', 'map_error', `failed to map event ${event.id} (${target.slug})`, {
        event_id: event.id,
        venue_slug: target.slug,
        error_message: (error as Error).message,
      });
      captureError(error, 'map_error', { event_id: event.id, venue_slug: target.slug });
      continue;
    }

    if (mapped.removed_at !== null) {
      totals.events_tombstoned += 1;
    }

    if (mapped.starts_at !== null && mapped.doors_at !== null && mapped.starts_at < mapped.doors_at) {
      totals.time_order_anomalies += 1;
      log(
        'warn',
        'time_order_anomaly',
        `event ${event.id} composes starts_at before doors_at — likely a past-midnight show_time on the advertised date`,
        {
          event_id: event.id,
          venue_slug: target.slug,
          date: event.date,
          doors_time: event.doors_time,
          show_time: event.show_time,
          source: event.source,
        }
      );
    }

    try {
      const { inserted } = await opts.upsertConcert(mapped, target.venue_id, scrapedAt);
      totals.upserts_total += 1;
      if (inserted) totals.upserts_inserted += 1;
      else totals.upserts_updated += 1;
    } catch (error) {
      totals.upsert_errors += 1;
      log('warn', 'upsert_error', `failed to upsert event ${event.id} (${mapped.source_id})`, {
        event_id: event.id,
        source_id: mapped.source_id,
        error_message: (error as Error).message,
      });
      captureError(error, 'upsert_error', { event_id: event.id, source_id: mapped.source_id });
    }
  }

  log('info', 'finished', `${JOB_NAME} done`, { ...totals });
  return totals;
};
