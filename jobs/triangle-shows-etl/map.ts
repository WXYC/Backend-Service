/**
 * Pure mapping layer for triangle-shows-etl: one source `EventResponse`
 * (triangle-shows `GET /api/v1/events`) → the `concerts` row shape.
 * No DB or network imports — everything here is unit-testable in
 * isolation, and the writer/orchestrator consume the `MappedConcert`
 * output. Field-mapping contract: BS#1589 Part 3.
 *
 * Time composition delegates to `nyWallClockToUtc` from @wxyc/database
 * (shared/database/src/ny-time.ts) — the same module the RHP writer's
 * `starts_on` derivation uses, so both concert writers agree on one
 * America/New_York conversion (including its DST gap/ambiguity policy).
 * That's the module's one import; it issues no queries, and the unit
 * suite resolves it through the standard database mock's re-export.
 */
import { nyWallClockToUtc } from '@wxyc/database';

/** Mirror of triangle-shows `VenueResponse` (backend/app/schemas.py). */
export type TriangleShowsVenue = {
  id: number;
  name: string;
  slug: string;
  city: string;
  capacity?: number | null;
  size_category: string;
  website?: string | null;
  color: string;
};

/** Mirror of triangle-shows `EventResponse` (backend/app/schemas.py). */
export type TriangleShowsEvent = {
  id: number;
  venue_id: number;
  name: string;
  artist: string | null;
  /** Single comma-separated string at the source, not a list. */
  support_artists: string | null;
  /** ISO calendar date, YYYY-MM-DD — venue-local (America/New_York). */
  date: string;
  /** ISO time, HH:MM:SS. */
  doors_time: string | null;
  show_time: string | null;
  ticket_url: string | null;
  price_min: number | null;
  price_max: number | null;
  image_url: string | null;
  genre: string | null;
  subgenre: string | null;
  /** Source `EventStatus`: on_sale | sold_out | cancelled | free. */
  status: string;
  age_restriction: string | null;
  description: string | null;
  source: string;
  /** Tier-prefixed (ext:/url:/hash:) stable identity — see the source_key
   *  contract in triangle-shows backend/README.md. Unique per venue only;
   *  the consumer key is ALWAYS venue-qualified (see mapEvent). */
  source_key: string;
  updated_at: string | null;
  /** Soft tombstone: when the venue stopped advertising the event. */
  removed_at: string | null;
  venue_name: string | null;
  venue_slug: string | null;
  venue_city: string | null;
  venue_color: string | null;
};

/** The concerts-row shape the writer binds. Prices are pre-formatted
 *  strings because drizzle's numeric columns bind strings. */
export type MappedConcert = {
  source_id: string;
  starts_on: string;
  starts_at: Date | null;
  doors_at: Date | null;
  headlining_artist_raw: string;
  title: string;
  supporting_artists_raw: string[];
  status: 'on_sale' | 'sold_out' | 'cancelled';
  price_min: string | null;
  price_max: string | null;
  age_restriction: string | null;
  ticket_url: string | null;
  image_url: string | null;
  removed_at: Date | null;
  raw: TriangleShowsEvent;
};

/**
 * Split the source's single comma-separated support string into the
 * text[] shape `supporting_artists_raw` carries. Commas are the source
 * convention (the Ticketmaster scraper joins with ', '; the others pass
 * free text) — a band name containing a comma splits wrong, which is
 * inherent to the free-text source, not worth a smarter parser.
 */
export const splitSupportArtists = (raw: string | null): string[] =>
  raw
    ? raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

const PASSTHROUGH_STATUSES = new Set(['on_sale', 'sold_out', 'cancelled'] as const);

/** numeric(8,2) caps at 999999.99. Source floats are unbounded and the
 *  scrapers' price regexes can misparse prose digits (a phone number in a
 *  Squarespace description) into absurd values — drop the price rather
 *  than fail the whole event on a PG numeric-overflow, every night. */
const MAX_STORABLE_PRICE = 999_999.99;

const formatPrice = (value: number | null): string | null => {
  if (value == null || !Number.isFinite(value)) return null;
  const formatted = value.toFixed(2);
  // Judge the ROUNDED value: toFixed carries 999999.995 to '1000000.00',
  // which is past the numeric(8,2) cap even though the raw input isn't.
  return Math.abs(Number(formatted)) > MAX_STORABLE_PRICE ? null : formatted;
};

/**
 * Map one source event to the concerts row shape.
 *
 * `venueSlug` is the slug resolved from the run's venue list by
 * `venue_id` — authoritative, unlike the event's own denormalized
 * `venue_slug` join field. It venue-qualifies the key:
 * `source_id = '<venue_slug>:' + source_key`, never bare `source_key`,
 * because triangle-shows uniqueness is per-venue and same-platform venue
 * pairs (rubies+stancyks VenuePilot, neptunes-parlour+boom-club
 * Squarespace, shadowbox-studio+slims MEC) can collide on ext:/url: keys.
 *
 * Throws on a status outside the source enum — the orchestrator counts
 * it as a map_error rather than this layer guessing.
 */
export const mapEvent = (event: TriangleShowsEvent, venueSlug: string): MappedConcert => {
  let status: MappedConcert['status'];
  let priceMin = event.price_min;
  if (event.status === 'free') {
    // BS has no 'free' state: a free show is on sale at $0. An explicit
    // source price wins over the derived zero.
    status = 'on_sale';
    priceMin = event.price_min ?? 0;
  } else if (PASSTHROUGH_STATUSES.has(event.status as never)) {
    status = event.status as MappedConcert['status'];
  } else {
    throw new Error(`unmappable status '${event.status}' on event ${event.id} (${venueSlug})`);
  }

  // Truthy fallback (not ??) so an empty/whitespace artist — which source
  // scrapers can emit — still falls back to the title; and name is trimmed
  // BEFORE the truthiness check so a whitespace-only name can't slip
  // through as ''. Both blank is unresolvable garbage: throw, counted as a
  // map_error, rather than write a headliner-less row the resolver
  // re-selects forever.
  const headliner = event.artist?.trim() || event.name.trim();
  if (headliner === '') {
    throw new Error(`blank artist AND name on event ${event.id} (${venueSlug}) — refusing a headliner-less row`);
  }

  return {
    source_id: `${venueSlug}:${event.source_key}`,
    // Verbatim: the source date IS the venue-local calendar day. Never
    // re-derived from starts_at (a NULL show_time would have nothing to
    // derive from).
    starts_on: event.date,
    starts_at: event.show_time ? nyWallClockToUtc(event.date, event.show_time) : null,
    doors_at: event.doors_time ? nyWallClockToUtc(event.date, event.doors_time) : null,
    // Truncation is code-point-safe (Array.from) so a 256-boundary can't
    // split a surrogate pair into a U+FFFD; PG's varchar(256) counts
    // characters, so 256 code points always fit.
    headlining_artist_raw: Array.from(headliner).slice(0, 256).join(''),
    title: event.name,
    supporting_artists_raw: splitSupportArtists(event.support_artists),
    status,
    price_min: formatPrice(priceMin),
    price_max: formatPrice(event.price_max),
    age_restriction: event.age_restriction,
    ticket_url: event.ticket_url,
    image_url: event.image_url,
    // Mirrored, both directions: a Date stamps the tombstone, an explicit
    // null clears it on reappearance. Absence-from-snapshot is never a
    // removal signal (rows age out at the source 7 days past their date).
    removed_at: event.removed_at ? new Date(event.removed_at) : null,
    raw: event,
  };
};
