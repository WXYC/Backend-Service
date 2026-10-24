/**
 * Wire types for the triangle-shows `/api/v1` surface, mirrored from
 * `backend/app/schemas.py` in WXYC/triangle-shows (EventResponse /
 * VenueResponse / HealthResponse). Hand-maintained, and deliberately a
 * CONSUMED-FIELDS SUBSET — fields the ETL never reads (venue_color,
 * updated_at, ...) are omitted to shrink the drift surface; the runtime
 * object still carries whatever JSON arrived, and the ETL's `raw_data`
 * column preserves that full payload so a drifted or omitted field is
 * recoverable without a re-pull.
 *
 * `tests/fixtures/triangle-shows/event-response.schema.json` is a vendored
 * snapshot of the fork's EventResponse; a contract test pins the shared
 * fixture to it (refresh: README "Refreshing the contract snapshot"). Fields
 * the snapshot marks optional but that BS reads as optional too (`headliner`,
 * `source_url`, `is_live_music`) stay optional here so an older fork still maps.
 *
 * Pydantic serializes Optional fields as explicit nulls, `date` as
 * `YYYY-MM-DD`, `time` as `HH:MM:SS`, and datetimes with an explicit UTC
 * offset (its UTCDateTime annotation).
 */

export type TsEvent = {
  id: number;
  venue_id: number;
  /** Event display name; NOT NULL at the source (String(500)). */
  name: string;
  artist: string | null;
  /**
   * Clean performer name, extracted upstream (WXYC/triangle-shows#18).
   * Nullable AND optional: best-effort at the source, and absent entirely
   * until the upstream change deploys — the ETL prefers it when present
   * and non-blank, falling back to the local heuristic (BS#1604).
   */
  headliner?: string | null;
  /**
   * Support-artist billing. Historically a single comma-joined string;
   * WXYC/triangle-shows#39 flips it to a JSON array (lossless — a comma
   * inside a name no longer corrupts). `splitSupportArtists` tolerates
   * both shapes so the consumer can deploy ahead of the source flip.
   */
  support_artists: string | string[] | null;
  /** Venue-local calendar date, `YYYY-MM-DD`. */
  date: string;
  doors_time: string | null;
  show_time: string | null;
  ticket_url: string | null;
  price_min: number | null;
  price_max: number | null;
  image_url: string | null;
  /** The event detail page on the venue's own site (the field the old iOS
   *  DTO decoded as the Box Office CTA target). Maps to `concerts.event_url`
   *  (BS#1609) unless it equals `ticket_url`. Optional here so a feed from a
   *  fork that predates triangle-shows#138 maps to NULL. */
  source_url?: string | null;
  genre: string | null;
  subgenre: string | null;
  /** Source EventStatus enum: on_sale | sold_out | cancelled | free. */
  status: string;
  age_restriction: string | null;
  description: string | null;
  /** The triangle-shows scraper type that produced the row (e.g. 'venuepilot'). */
  source: string;
  /** Stable per-event identity, tier-prefixed (ext:/url:/hash:), ≤1100 chars.
   *  UNIQUE ONLY PER-VENUE — always qualify with venue_slug when keying. */
  source_key: string;
  /**
   * The source's live-music classifier verdict (WXYC/triangle-shows#133).
   * Required at the source; optional here so a feed from an older fork maps
   * to NULL rather than failing.
   */
  is_live_music?: boolean | null;
  /** Soft tombstone: when the venue stopped advertising the event. */
  removed_at: string | null;
  // Denormalized venue fields joined into the event response.
  venue_name: string | null;
  venue_slug: string | null;
  venue_city: string | null;
};

export type TsVenue = {
  id: number;
  name: string;
  slug: string;
  city: string;
};

export type TsHealth = {
  status: string;
  event_count: number;
  venue_count: number;
  /** Null when no scrape has run yet. */
  last_scrape: string | null;
  version: string | null;
};
