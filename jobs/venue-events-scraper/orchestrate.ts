/**
 * Orchestrator for venue-events-scraper.
 *
 * Per-site loop:
 *   1. Fetch the /events/ index page → enumerate `/event/<slug>/` URLs.
 *   2. Concurrently fetch each event detail page (cap = `concurrency`).
 *   3. Parse the JSON-LD `Event` block from each page → ParsedConcert.
 *   4. Resolve the venue slug to a venue_id (cached per run).
 *   5. UPSERT one concerts row per parsed event by (source, source_id).
 *
 * Dependencies (fetch / parse / venue lookup / write) are injected so
 * unit tests can drive the orchestrator without network or DB.
 * Production wires them via `job.ts`.
 *
 * Errors at any stage are caught, counted, and Sentry-captured. A
 * single bad page never wedges the run; a wholesale source-format
 * regression surfaces as a high `parse_errors` count plus loud Sentry
 * events.
 */

import type { ParsedConcert } from './rhp-types.js';
import type { RhpVenueConfig } from './rhp-venues.js';
import { captureError, log } from './logger.js';

const JOB_NAME = 'venue-events-scraper';

export type FetchHtmlFn = (url: string) => Promise<string>;
export type ParseEventPageFn = (
  venue: RhpVenueConfig,
  eventPageUrl: string,
  eventPageHtml: string
) => ParsedConcert | null;
export type ExtractEventLinksFn = (indexHtml: string, baseUrl: string) => string[];
export type ResolveVenueIdFn = (
  slug: string,
  fallbackName: string | null,
  fallbackAddress: string | null
) => Promise<number>;
export type UpsertConcertFn = (
  parsed: ParsedConcert,
  venueId: number,
  scrapedAt: Date
) => Promise<{ concert_id: number; inserted: boolean }>;
export type MapConcurrentFn = <T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
) => Promise<(R | null)[]>;

export type Totals = {
  sites_attempted: number;
  sites_succeeded: number;
  /** Index-page fetches that threw. */
  index_errors: number;
  events_seen: number;
  /** Per-event-page fetches that threw (network / 5xx / 4xx). */
  fetch_errors: number;
  /** Parse-step failures (malformed JSON-LD, missing required fields). */
  parse_errors: number;
  /** Event pages whose ld+json block was missing — distinct from parse
   *  errors, often a 404 page lurking inside the index. */
  pages_without_event_block: number;
  upserts_total: number;
  upserts_inserted: number;
  upserts_updated: number;
  /** Venue-resolution failures (DB lookup of venues row). Split out from
   *  `upsert_errors` so a DB-connectivity / FK / venue-table incident
   *  doesn't look like an INSERT-path / enum-drift incident in dashboards. */
  venue_resolve_errors: number;
  /** Concert UPSERT failures (INSERT/ON CONFLICT into concerts). */
  upsert_errors: number;
};

const emptyTotals = (): Totals => ({
  sites_attempted: 0,
  sites_succeeded: 0,
  index_errors: 0,
  events_seen: 0,
  fetch_errors: 0,
  parse_errors: 0,
  pages_without_event_block: 0,
  upserts_total: 0,
  upserts_inserted: 0,
  upserts_updated: 0,
  venue_resolve_errors: 0,
  upsert_errors: 0,
});

/** Per-site counters logged on `site_done`. Mirrors the per-event-tag fields
 *  of `Totals` without the run-level ones (sites_attempted, sites_succeeded,
 *  index_errors) — those are not meaningful per-site. */
type SiteTotals = Omit<Totals, 'sites_attempted' | 'sites_succeeded' | 'index_errors'>;

const emptySiteTotals = (): SiteTotals => ({
  events_seen: 0,
  fetch_errors: 0,
  parse_errors: 0,
  pages_without_event_block: 0,
  upserts_total: 0,
  upserts_inserted: 0,
  upserts_updated: 0,
  venue_resolve_errors: 0,
  upsert_errors: 0,
});

export type RunOptions = {
  sites: readonly RhpVenueConfig[];
  concurrency: number;
  fetchHtml: FetchHtmlFn;
  extractEventLinks: ExtractEventLinksFn;
  parseEventPage: ParseEventPageFn;
  resolveVenueId: ResolveVenueIdFn;
  upsertConcert: UpsertConcertFn;
  mapConcurrent: MapConcurrentFn;
  /** Injectable for tests. Defaults to `() => new Date()` in production. */
  now?: () => Date;
};

export const runScraper = async (opts: RunOptions): Promise<Totals> => {
  const totals = emptyTotals();
  const now = opts.now ?? (() => new Date());

  log('info', 'started', `${JOB_NAME} starting`, {
    sites: opts.sites.map((s) => s.site_slug),
    concurrency: opts.concurrency,
  });

  for (const site of opts.sites) {
    totals.sites_attempted += 1;
    const siteStart = Date.now();

    let indexHtml: string;
    try {
      indexHtml = await opts.fetchHtml(`${site.base_url}/events/`);
    } catch (error) {
      totals.index_errors += 1;
      log('error', 'index_error', `failed to fetch /events/ index for ${site.site_slug}`, {
        site_slug: site.site_slug,
        error_message: (error as Error).message,
      });
      captureError(error, 'index_error', { site_slug: site.site_slug });
      continue;
    }

    const eventUrls = opts.extractEventLinks(indexHtml, site.base_url);
    totals.events_seen += eventUrls.length;
    log('info', 'index_done', `discovered ${eventUrls.length} event pages on ${site.site_slug}`, {
      site_slug: site.site_slug,
      event_count: eventUrls.length,
    });

    const results = await opts.mapConcurrent(eventUrls, opts.concurrency, (url) =>
      processOneEvent(site, url, opts, now())
    );

    // Tally per-site so the site_done line reports just this site's work,
    // not the cumulative totals carried across sites. Cumulative totals
    // still surface in the final `finished` log.
    const siteTotals = emptySiteTotals();
    siteTotals.events_seen = eventUrls.length;
    for (const r of results) {
      if (r === null) continue;
      if (r.kind === 'fetch_error') siteTotals.fetch_errors += 1;
      else if (r.kind === 'parse_error') siteTotals.parse_errors += 1;
      else if (r.kind === 'no_event_block') siteTotals.pages_without_event_block += 1;
      else if (r.kind === 'venue_resolve_error') siteTotals.venue_resolve_errors += 1;
      else if (r.kind === 'upsert_error') siteTotals.upsert_errors += 1;
      else if (r.kind === 'upserted') {
        siteTotals.upserts_total += 1;
        if (r.inserted) siteTotals.upserts_inserted += 1;
        else siteTotals.upserts_updated += 1;
      }
    }
    totals.fetch_errors += siteTotals.fetch_errors;
    totals.parse_errors += siteTotals.parse_errors;
    totals.pages_without_event_block += siteTotals.pages_without_event_block;
    totals.venue_resolve_errors += siteTotals.venue_resolve_errors;
    totals.upsert_errors += siteTotals.upsert_errors;
    totals.upserts_total += siteTotals.upserts_total;
    totals.upserts_inserted += siteTotals.upserts_inserted;
    totals.upserts_updated += siteTotals.upserts_updated;

    totals.sites_succeeded += 1;
    log('info', 'site_done', `${site.site_slug} done in ${Date.now() - siteStart}ms`, {
      site_slug: site.site_slug,
      elapsed_ms: Date.now() - siteStart,
      ...siteTotals,
    });
  }

  log('info', 'finished', `${JOB_NAME} done`, { ...totals });
  return totals;
};

type OneEventResult =
  | { kind: 'upserted'; inserted: boolean }
  | { kind: 'fetch_error' }
  | { kind: 'parse_error' }
  | { kind: 'no_event_block' }
  | { kind: 'venue_resolve_error' }
  | { kind: 'upsert_error' };

const processOneEvent = async (
  site: RhpVenueConfig,
  eventPageUrl: string,
  opts: RunOptions,
  scrapedAt: Date
): Promise<OneEventResult> => {
  let html: string;
  try {
    html = await opts.fetchHtml(eventPageUrl);
  } catch (error) {
    log('warn', 'fetch_error', `failed to fetch ${eventPageUrl}`, {
      site_slug: site.site_slug,
      url: eventPageUrl,
      error_message: (error as Error).message,
    });
    captureError(error, 'fetch_error', { site_slug: site.site_slug, url: eventPageUrl });
    return { kind: 'fetch_error' };
  }

  let parsed: ParsedConcert | null;
  try {
    parsed = opts.parseEventPage(site, eventPageUrl, html);
  } catch (error) {
    log('warn', 'parse_error', `failed to parse ${eventPageUrl}`, {
      site_slug: site.site_slug,
      url: eventPageUrl,
      error_message: (error as Error).message,
    });
    captureError(error, 'parse_error', { site_slug: site.site_slug, url: eventPageUrl });
    return { kind: 'parse_error' };
  }

  if (parsed === null) {
    return { kind: 'no_event_block' };
  }

  let venueId: number;
  try {
    venueId = await opts.resolveVenueId(parsed.venue_slug, parsed.venue_name, parsed.venue_address);
  } catch (error) {
    log('warn', 'venue_resolve_error', `failed to resolve venue for ${eventPageUrl}`, {
      site_slug: site.site_slug,
      url: eventPageUrl,
      venue_slug: parsed.venue_slug,
      error_message: (error as Error).message,
    });
    captureError(error, 'venue_resolve_error', {
      site_slug: site.site_slug,
      url: eventPageUrl,
      venue_slug: parsed.venue_slug,
    });
    return { kind: 'venue_resolve_error' };
  }

  try {
    const { inserted } = await opts.upsertConcert(parsed, venueId, scrapedAt);
    return { kind: 'upserted', inserted };
  } catch (error) {
    log('warn', 'upsert_error', `failed to upsert concert for ${eventPageUrl}`, {
      site_slug: site.site_slug,
      url: eventPageUrl,
      error_message: (error as Error).message,
    });
    captureError(error, 'upsert_error', { site_slug: site.site_slug, url: eventPageUrl });
    return { kind: 'upsert_error' };
  }
};
