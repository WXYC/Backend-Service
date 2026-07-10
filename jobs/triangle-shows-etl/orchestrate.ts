/**
 * Orchestrator for triangle-shows-etl.
 *
 * Run shape:
 *   1. Health probe — loud Sentry warning when the source's `last_scrape`
 *      is > 24h stale, ABSENT, or unparseable (its scheduler scrapes
 *      several times daily — indie venues 06:00/12:00/18:00 ET, the
 *      Ticketmaster job twice daily — so the latest pre-pull scrape is
 *      18:00 ET and ~7h-old data at the 05:05 UTC pull is normal).
 *      Non-fatal: a stale mirror is better than no mirror, and the
 *      staleness has its own alert.
 *   2. Venue list — partition assertions (`venues.ts`), then provision
 *      every ingested venue so all 16 exist even before their first event.
 *   3. Full-snapshot events pull (back-dated start; tombstones included).
 *   4. Per event: skip excluded slugs, map, resolve venue (through the
 *      injected memoized cache — the ONLY memoization layer), UPSERT.
 *   5. Run guards — the run FAILS (throws, non-zero exit) when the source
 *      returns an empty snapshot, when ingestable events exist but zero
 *      upserted, or when failures reach successes (>= half failing).
 *      Cron-success monitoring must not stay green through a wholesale
 *      regression, and a 200-with-empty-array is a source regression,
 *      not a success (a live Triangle calendar is never empty).
 *
 * Dependencies are injected so unit tests drive the orchestrator without
 * network or DB; production wires them in `job.ts`. Per-event errors are
 * caught, counted, and logged — one bad event never wedges the run — but
 * Sentry captures are DEDUPED per (step, message) per run, so a wholesale
 * drift (a new source status value across 1,500 events) is one Sentry
 * event plus honest counters, not a quota-burning flood. Venues whose
 * provisioning failed are negative-cached for the rest of the run: their
 * events are counted and skipped without re-running the doomed INSERT.
 *
 * New venue rows (xmax says INSERT happened) are surfaced as a single
 * end-of-run Sentry warning: a venue appearing at the source is the cue
 * to re-check the RHP double-coverage partition (BS#1570 Decision 1) —
 * the startup assertion only catches a known overlap DISAPPEARING.
 */

import type { TsEvent, TsHealth, TsVenue } from './types.js';
import { mapEvent, backdatedStart, type MappedEvent } from './map.js';
import { assertVenuePartition, ingestedVenues, isExcluded } from './venues.js';
import { captureError, captureWarning, log } from './logger.js';

const JOB_NAME = 'triangle-shows-etl';

/** Source freshness ceiling before we warn (scrapes run twice daily). */
const SOURCE_STALE_MS = 24 * 60 * 60 * 1000;

export type ResolveVenueIdFn = (
  slug: string,
  name: string,
  city: string
) => Promise<{ venue_id: number; created: boolean }>;
export type UpsertConcertFn = (
  mapped: MappedEvent,
  venueId: number,
  scrapedAt: Date
) => Promise<{ concert_id: number; inserted: boolean }>;

export type Totals = {
  /** Venue list length at the source (ingested + excluded). */
  venues_seen: number;
  /** Venues provisioned/refreshed from the /venues list (the ingested partition). */
  venues_ingested: number;
  /** Venue rows this run INSERTed (vs refreshed) — the partition-drift cue. */
  venues_created: number;
  /** Venues provisioned on demand from event-denormalized fields (list drift). */
  venues_provisioned_on_demand: number;
  events_seen: number;
  /** Events skipped because their venue is RHP-covered (Decision 1). */
  events_excluded: number;
  /** Events skipped because their venue's provisioning already failed this run. */
  events_skipped_failed_venue: number;
  /** `mapEvent` failures (contract drift: unknown status, missing venue_slug, non-ISO date). */
  map_errors: number;
  venue_resolve_errors: number;
  upsert_errors: number;
  upserts_total: number;
  upserts_inserted: number;
  upserts_updated: number;
  /** Upserted events carrying a source tombstone this run. */
  tombstones_seen: number;
  /** True when the health probe reported last_scrape > 24h old, absent, or unparseable. */
  source_stale: boolean;
};

const emptyTotals = (): Totals => ({
  venues_seen: 0,
  venues_ingested: 0,
  venues_created: 0,
  venues_provisioned_on_demand: 0,
  events_seen: 0,
  events_excluded: 0,
  events_skipped_failed_venue: 0,
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

  // Sentry dedup: capture each distinct (step, message-class) once per
  // run; the counters + per-event log lines carry the volume. Digits are
  // normalized out of the key because the thrown messages embed per-event
  // ids and values ("event id 1523", a raw date string) — without this,
  // 1,500 same-class failures would produce 1,500 distinct keys and the
  // dedup would be a no-op exactly when it matters.
  const capturedKeys = new Set<string>();
  const captureOnce = (error: unknown, step: string, extra: Record<string, unknown> = {}): void => {
    const key = `${step}:${(error as Error).message.replace(/\d+/g, '#')}`;
    if (capturedKeys.has(key)) return;
    capturedKeys.add(key);
    captureError(error, step, extra);
  };

  log('info', 'started', `${JOB_NAME} starting`, {});

  // 1. Health probe (non-fatal; staleness gets its own loud signal).
  try {
    const health = await opts.fetchHealth();
    // NaN (unparseable timestamp) must classify as STALE, not fresh —
    // Number.isFinite is false for both NaN and the null-absent case.
    const lastScrapeMs = health.last_scrape ? new Date(health.last_scrape).getTime() : NaN;
    totals.source_stale = !Number.isFinite(lastScrapeMs) || scrapedAt.getTime() - lastScrapeMs > SOURCE_STALE_MS;
    if (totals.source_stale) {
      log('warn', 'source_stale', 'triangle-shows last_scrape is stale, absent, or unparseable', {
        last_scrape: health.last_scrape,
        threshold_hours: 24,
      });
      captureWarning(
        `triangle-shows /api/v1/health.last_scrape is ${health.last_scrape ?? 'absent'} (stale/unparseable vs the 24h ceiling) — mirroring stale data`,
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
    captureOnce(error, 'health_error');
  }

  // 2. Venue partition + provisioning. assertVenuePartition throws on
  // drift — that is the run failing loudly, by design.
  const sourceVenues = await opts.fetchVenues();
  totals.venues_seen = sourceVenues.length;
  assertVenuePartition(sourceVenues);

  // Negative cache: slugs whose provisioning failed this run. Their events
  // are counted + skipped without re-running the doomed INSERT per event
  // (which would also bury the one root-cause Sentry event in noise).
  const failedSlugs = new Set<string>();
  const listedSlugs = new Set<string>();
  const createdSlugs: string[] = [];
  const warnedUnlistedSlugs = new Set<string>();
  // Fallback classifier for excluded venues: if a source glitch nulls an
  // event's denormalized venue_slug, its venue_id can still prove the
  // event belongs to an RHP-covered venue — those must count as excluded,
  // not as map errors inflating the majority-failure guard over events
  // this job would have skipped anyway.
  const excludedVenueIds = new Set(sourceVenues.filter((v) => isExcluded(v.slug)).map((v) => v.id));

  for (const venue of ingestedVenues(sourceVenues)) {
    listedSlugs.add(venue.slug);
    try {
      const { created } = await opts.resolveVenueId(venue.slug, venue.name, venue.city);
      totals.venues_ingested += 1;
      if (created) {
        totals.venues_created += 1;
        createdSlugs.push(venue.slug);
      }
    } catch (error) {
      failedSlugs.add(venue.slug);
      totals.venue_resolve_errors += 1;
      log('error', 'venue_provision_error', `failed to provision venue ${venue.slug}`, {
        venue_slug: venue.slug,
        error_message: (error as Error).message,
      });
      captureOnce(error, 'venue_provision_error', { venue_slug: venue.slug });
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

  // 4. Per-event map -> resolve -> upsert. Venue resolution goes through
  // the injected memoized cache (the only POSITIVE cache; failedSlugs
  // above is the negative side); the step-2 loop warmed it for every
  // listed venue.
  for (const event of events) {
    if ((event.venue_slug && isExcluded(event.venue_slug)) || excludedVenueIds.has(event.venue_id)) {
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
      captureOnce(error, 'map_error', { event_id: event.id, venue_slug: event.venue_slug });
      continue;
    }

    if (failedSlugs.has(mapped.venue_slug)) {
      totals.events_skipped_failed_venue += 1;
      continue;
    }

    if (!listedSlugs.has(mapped.venue_slug) && !warnedUnlistedSlugs.has(mapped.venue_slug)) {
      // A venue absent from /venues (added mid-run, or list drift) — the
      // memoized resolver provisions it on demand from the event's
      // denormalized fields rather than dropping its events. Warn once
      // per slug, not per event.
      warnedUnlistedSlugs.add(mapped.venue_slug);
      log(
        'warn',
        'venue_not_in_list',
        `event venue ${mapped.venue_slug} missing from /venues; provisioning on demand`,
        {
          venue_slug: mapped.venue_slug,
          event_id: event.id,
        }
      );
    }

    let venueId: number;
    try {
      // Trimmed-|| like the artist fallback: heterogeneous scrapers can
      // emit '' where they mean "unknown", and '' satisfies NOT NULL.
      const { venue_id, created } = await opts.resolveVenueId(
        mapped.venue_slug,
        event.venue_name?.trim() || mapped.venue_slug,
        event.venue_city?.trim() || 'Unknown'
      );
      venueId = venue_id;
      if (created) {
        totals.venues_created += 1;
        totals.venues_provisioned_on_demand += 1;
        createdSlugs.push(mapped.venue_slug);
      }
    } catch (error) {
      failedSlugs.add(mapped.venue_slug);
      totals.venue_resolve_errors += 1;
      log('warn', 'venue_resolve_error', `failed to resolve venue for event id ${event.id}`, {
        event_id: event.id,
        venue_slug: mapped.venue_slug,
        error_message: (error as Error).message,
      });
      captureOnce(error, 'venue_resolve_error', { event_id: event.id, venue_slug: mapped.venue_slug });
      continue;
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
      captureOnce(error, 'upsert_error', { event_id: event.id, source_id: mapped.concert.source_id });
    }
  }

  if (createdSlugs.length > 0) {
    // One event per run, listing every new row. On the very first run this
    // names all 16 — after that, any entry is either source venue growth
    // or /venues drift, and both warrant re-checking the RHP partition.
    captureWarning(
      `triangle-shows-etl provisioned ${createdSlugs.length} NEW venue row(s): ${createdSlugs.join(', ')} — re-check the RHP double-coverage partition (BS#1570 Decision 1)`,
      'venues_created',
      { slugs: createdSlugs }
    );
  }

  log('info', 'finished', `${JOB_NAME} done`, { ...totals });

  // 5. Run guards — throw AFTER the totals log so the numbers are always
  // visible. Tested via orchestrate.test.ts; keeping them here (not
  // job.ts) is what makes them testable at all.
  if (totals.events_seen === 0) {
    throw new Error(
      'source returned an empty snapshot (0 events) — a live Triangle calendar is never empty; ' +
        'treating as a source regression (DB reset, route change), not a successful run'
    );
  }
  const ingestable = totals.events_seen - totals.events_excluded;
  const failed = ingestable - totals.upserts_total;
  if (ingestable > 0 && totals.upserts_total === 0) {
    throw new Error(
      `${ingestable} ingestable events pulled but 0 upserted ` +
        `(map_errors=${totals.map_errors}, venue_resolve_errors=${totals.venue_resolve_errors}, ` +
        `skipped_failed_venue=${totals.events_skipped_failed_venue}, upsert_errors=${totals.upsert_errors}); ` +
        `aborting with non-zero exit`
    );
  }
  // >= not >: an exactly-50% failure rate is still a wholesale regression
  // for a mirror (e.g. one platform's scrapers breaking — the Ticketmaster
  // quad is roughly half the corpus by volume) and must not stay green.
  if (failed > 0 && failed >= totals.upserts_total) {
    throw new Error(
      `failures reached successes (${failed} failed vs ${totals.upserts_total} upserted of ${ingestable} ingestable); ` +
        `treating as a wholesale regression — see map_errors/venue_resolve_errors/upsert_errors in the finished log`
    );
  }

  return totals;
};
