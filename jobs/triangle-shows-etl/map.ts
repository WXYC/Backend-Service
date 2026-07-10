/**
 * Pure `EventResponse` -> concerts-row mapping (the BS#1589 field table).
 * No DB, no network — everything contract-shaped lives here so the unit
 * suite can pin it without mocks.
 *
 * Keying: `source_id = '<venue_slug>:' + source_key`. NEVER bare
 * `source_key` — triangle-shows uniqueness is per-venue
 * `(venue_id, source_key)`. The ingested set contains several
 * same-platform groupings (a Ticketmaster quad, an rhp_events pair, and
 * three pairs whose `ext:`/`url:` tier keys are the collision-prone
 * kind: rubies+stancyks VenuePilot, neptunes-parlour+boom-club
 * Squarespace, shadowbox-studio+slims MEC) — the qualifier protects all
 * of them uniformly.
 */

import { nyCalendarDate, nyWallClockToUtc, type NewConcert } from '@wxyc/database';
import { clampCodePoints } from './writer.js';
import type { TsEvent } from './types.js';

const HEADLINER_MAX = 256;

// Same shape ny-time enforces; validated here for BOTH branches so a
// source date-format drift on date-only events fails as a map_error (the
// documented contract-drift counter), not as an opaque upsert_error at
// the Drizzle date-column bind.
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Everything the writer needs: the concert payload minus the run-scoped
 *  columns (`venue_id` resolves via the per-run slug cache; `scraped_at`
 *  is stamped per run). `venue_slug` is the one venue field that earns a
 *  place here — mapEvent validates it non-null; the orchestrator reads
 *  any other venue detail off the source event it already holds. */
export type MappedEvent = {
  venue_slug: string;
  concert: Omit<NewConcert, 'venue_id' | 'scraped_at'>;
};

/** Split the source's single comma-joined string into the `text[]` shape
 *  `concerts.supporting_artists_raw` expects: trimmed, empties dropped. */
export const splitSupportArtists = (raw: string | null): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** Dollars as the 2-decimal string Drizzle's numeric(8,2) column binds. */
const toPrice = (value: number | null): string | null => (value === null ? null : value.toFixed(2));

/**
 * Map the source EventStatus onto `concert_status_enum`. Complete against
 * the source enum (on_sale / sold_out / cancelled / free); an unknown
 * value throws so upstream enum drift fails loudly per-event instead of
 * mislabeling rows. BS's `rescheduled` has no producer on this path.
 * `free` collapses to on_sale + a zero floor price — "free" is an
 * availability fact plus a price fact, and price is where we model it.
 */
const mapStatus = (event: TsEvent): { status: 'on_sale' | 'sold_out' | 'cancelled'; priceMin: string | null } => {
  switch (event.status) {
    case 'on_sale':
    case 'sold_out':
    case 'cancelled':
      return { status: event.status, priceMin: toPrice(event.price_min) };
    case 'free':
      return { status: 'on_sale', priceMin: toPrice(event.price_min ?? 0) };
    default:
      throw new Error(`mapEvent: unknown source status '${event.status}' (event id ${event.id})`);
  }
};

export const mapEvent = (event: TsEvent): MappedEvent => {
  if (!event.venue_slug) {
    throw new Error(`mapEvent: event id ${event.id} has no venue_slug; cannot compose the venue-qualified source_id`);
  }
  if (!ISO_DATE_SHAPE.test(event.date)) {
    throw new Error(`mapEvent: event id ${event.id} has non-ISO date '${event.date}' (want YYYY-MM-DD)`);
  }
  const { status, priceMin } = mapStatus(event);
  // `||` on the trimmed artist, not `??`: heterogeneous scrapers can emit
  // '' where they mean "unknown", and an empty headliner defeats both the
  // resolver and any display — `name` is NOT NULL, so the fallback is total.
  const headliner = event.artist?.trim() || event.name;

  return {
    venue_slug: event.venue_slug,
    concert: {
      source: 'triangle_shows',
      source_id: `${event.venue_slug}:${event.source_key}`,
      starts_on: event.date,
      // Date-only events keep starts_at NULL — never a fabricated time.
      starts_at: event.show_time ? nyWallClockToUtc(event.date, event.show_time) : null,
      doors_at: event.doors_time ? nyWallClockToUtc(event.date, event.doors_time) : null,
      // Truncated to the column width (source String(500) vs varchar(256));
      // code-point-safe so an astral char at the boundary can't strand a
      // lone surrogate as U+FFFD in the DB.
      headlining_artist_raw: clampCodePoints(headliner, HEADLINER_MAX),
      title: event.name,
      supporting_artists_raw: splitSupportArtists(event.support_artists),
      ticket_url: event.ticket_url,
      image_url: event.image_url,
      price_min: priceMin,
      price_max: toPrice(event.price_max),
      age_restriction: event.age_restriction,
      status,
      // Mirrors the source's tombstone in BOTH directions (the writer's
      // set clause clears it when a delisted event reappears).
      removed_at: event.removed_at ? new Date(event.removed_at) : null,
      // genre/subgenre/description live only here (BS#1570 Decision 2).
      raw_data: event,
    },
  };
};

/**
 * The `start` param for the events pull: 8 days before `now` on the NY
 * calendar. Contract-required back-dating — the source's default
 * start=today window hides a tombstone stamped on the event's own show
 * date, and source rows hard-delete 7 days past their date.
 */
export const backdatedStart = (now: Date): string => {
  const today = nyCalendarDate(now);
  const backdated = new Date(`${today}T00:00:00Z`);
  backdated.setUTCDate(backdated.getUTCDate() - 8);
  return backdated.toISOString().slice(0, 10);
};
