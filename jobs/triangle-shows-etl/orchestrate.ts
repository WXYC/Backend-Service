/**
 * Orchestrator for triangle-shows-etl.
 *
 * Run shape:
 *   1. Health probe — loud Sentry warning when the source's `last_scrape`
 *      is > 24h stale (its scheduler scrapes 06:00/18:00 ET, so ~7h-old
 *      data at the 05:05 UTC pull is normal). Non-fatal: a stale mirror
 *      is better than no mirror, and the staleness has its own alert.
 *   2. Venue list — partition assertions (`venues.ts`), then provision
 *      every ingested venue so all 16 exist even before their first event.
 *   3. Full-snapshot events pull (back-dated start; tombstones included).
 *   4. Per event: skip excluded slugs, map, resolve venue, UPSERT.
 *
 * Dependencies are injected so unit tests drive the orchestrator without
 * network or DB; production wires them in `job.ts`. Per-event errors are
 * caught, counted, and Sentry-captured — one bad event never wedges the
 * run; a wholesale contract regression surfaces as a high `map_errors`
 * count plus the zero-upsert guard.
 */

import type { TsEvent, TsHealth, TsVenue } from './types.js';
import { mapEvent, backdatedStart, type MappedEvent } from './map.js';
import { assertVenuePartition, ingestedVenues, isExcluded } from './venues.js';
import { captureError, captureWarning, log } from './logger.js';

const JOB_NAME = 'triangle-shows-etl';

/** Source freshness ceiling before we warn (scrapes run twice daily). */
const SOURCE_STALE_MS = 24 * 60 * 60 * 1000;

export type ResolveVenueIdFn = (slug: string, name: string, city: string) => Promise<number>;
export type UpsertConcertFn = (
  mapped: MappedEvent,
  venueId: number,
  scrapedAt: Date
) => Promise<{ concert_id: number; inserted: boolean }>;

export type Totals = {
  /** Venue list length at the source (ingested + excluded). */
  venues_seen: number;
  /** Venues this run provisioned/refreshed (the ingested partition). */
  venues_ingested: number;
  events_seen: number;
  /** Events skipped because their venue is RHP-covered (Decision 1). */
  events_excluded: number;
  /** `mapEvent` failures (contract drift: unknown status, missing venue_slug). */
  map_errors: number;
  venue_resolve_errors: number;
  upsert_errors: number;
  upserts_total: number;
  upserts_inserted: number;
  upserts_updated: number;
  /** Upserted events carrying a source tombstone this run. */
  tombstones_seen: number;
  /** True when the health probe reported last_scrape > 24h old (or absent). */
  source_stale: boolean;
};

const emptyTotals = (): Totals => ({
  venues_seen: 0,
  venues_ingested: 0,
  events_seen: 0,
  events_excluded: 0,
  map_errors: 0,
  venue_resolve_errors: 0,
  upsert_errors: 0,
  upserts_total: 0,
  upserts_inserted: 0,
  upserts_updated: 0,
  tombstones_seen: 0,
  source_stale: false,
});

export type RunOptions = {
  fetchHealth: () => Promise<TsHealth>;
  fetchVenues: () => Promise<TsVenue[]>;
  fetchEvents: (start: string) => Promise<TsEvent[]>;
  resolveVenueId: ResolveVenueIdFn;
  upsertConcert: UpsertConcertFn;
  /** Injectable for tests. Defaults to `() => new Date()` in production. */
  now?: () => Date;
};

export const runEtl = async (opts: RunOptions): Promise<Totals> => {
  const totals = emptyTotals();
  const now = opts.now ?? (() => new Date());
  const scrapedAt = now();

  log('info', 'started', `${JOB_NAME} starting`, {});

  // 1. Health probe (non-fatal; staleness gets its own loud signal).
  try {
    const health = await opts.fetchHealth();
    const lastScrapeMs = health.last_scrape ? new Date(health.last_scrape).getTime() : null;
    totals.source_stale = lastScrapeMs === null || scrapedAt.getTime() - lastScrapeMs > SOURCE_STALE_MS;
    if (totals.source_stale) {
      log('warn', 'source_stale', 'triangle-shows last_scrape is stale or absent', {
        last_scrape: health.last_scrape,
        threshold_hours: 24,
      });
      captureWarning(
        `triangle-shows /api/v1/health.last_scrape is ${health.last_scrape ?? 'absent'} (> 24h before this pull) — mirroring stale data`,
        'source_stale',
        { last_scrape: health.last_scrape }
      );
    }
  } catch (error) {
    // The events pull is about to exercise the same host; let it decide
    // whether the run fails. The probe failure still gets a warning.
    totals.source_stale = true;
    log('warn', 'health_error', 'triangle-shows health probe failed', {
      error_message: (error as Error).message,
    });
    captureError(error, 'health_error');
  }

  // 2. Venue partition + provisioning. assertVenuePartition throws on
  // drift — that is the run failing loudly, by design.
  const sourceVenues = await opts.fetchVenues();
  totals.venues_seen = sourceVenues.length;
  assertVenuePartition(sourceVenues);

  const venueIds = new Map<string, number>();
  for (const venue of ingestedVenues(sourceVenues)) {
    try {
      venueIds.set(venue.slug, await opts.resolveVenueId(venue.slug, venue.name, venue.city));
      totals.venues_ingested += 1;
    } catch (error) {
      totals.venue_resolve_errors += 1;
      log('error', 'venue_provision_error', `failed to provision venue ${venue.slug}`, {
        venue_slug: venue.slug,
        error_message: (error as Error).message,
      });
      captureError(error, 'venue_provision_error', { venue_slug: venue.slug });
    }
  }

  // 3. Full-snapshot pull.
  const start = backdatedStart(scrapedAt);
  const events = await opts.fetchEvents(start);
  totals.events_seen = events.length;
  log('info', 'events_fetched', `pulled ${events.length} events (start=${start})`, {
    event_count: events.length,
    start,
  });

  // 4. Per-event map -> resolve -> upsert.
  for (const event of events) {
    if (event.venue_slug && isExcluded(event.venue_slug)) {
      totals.events_excluded += 1;
      continue;
    }

    let mapped: MappedEvent;
    try {
      mapped = mapEvent(event);
    } catch (error) {
      totals.map_errors += 1;
      log('warn', 'map_error', `failed to map event id ${event.id}`, {
        event_id: event.id,
        venue_slug: event.venue_slug,
        error_message: (error as Error).message,
      });
      captureError(error, 'map_error', { event_id: event.id, venue_slug: event.venue_slug });
      continue;
    }

    let venueId = venueIds.get(mapped.venue_slug);
    if (venueId === undefined) {
      // A venue that wasn't in the /venues list (added mid-run, or list
      // drift) — provision on demand from the event's denormalized
      // fields rather than dropping its events.
      try {
        venueId = await opts.resolveVenueId(
          mapped.venue_slug,
          mapped.venue_name ?? mapped.venue_slug,
          mapped.venue_city ?? 'Unknown'
        );
        venueIds.set(mapped.venue_slug, venueId);
        log(
          'warn',
          'venue_not_in_list',
          `event venue ${mapped.venue_slug} missing from /venues; provisioned on demand`,
          {
            venue_slug: mapped.venue_slug,
            event_id: event.id,
          }
        );
      } catch (error) {
        totals.venue_resolve_errors += 1;
        log('warn', 'venue_resolve_error', `failed to resolve venue for event id ${event.id}`, {
          event_id: event.id,
          venue_slug: mapped.venue_slug,
          error_message: (error as Error).message,
        });
        captureError(error, 'venue_resolve_error', { event_id: event.id, venue_slug: mapped.venue_slug });
        continue;
      }
    }

    try {
      const { inserted } = await opts.upsertConcert(mapped, venueId, scrapedAt);
      totals.upserts_total += 1;
      if (inserted) totals.upserts_inserted += 1;
      else totals.upserts_updated += 1;
      if (mapped.concert.removed_at) totals.tombstones_seen += 1;
    } catch (error) {
      totals.upsert_errors += 1;
      log('warn', 'upsert_error', `failed to upsert event id ${event.id}`, {
        event_id: event.id,
        source_id: mapped.concert.source_id,
        error_message: (error as Error).message,
      });
      captureError(error, 'upsert_error', { event_id: event.id, source_id: mapped.concert.source_id });
    }
  }

  log('info', 'finished', `${JOB_NAME} done`, { ...totals });
  return totals;
};
