/**
 * Wire types for the triangle-shows `/api/v1` surface, mirrored from
 * `backend/app/schemas.py` in WXYC/triangle-shows (EventResponse /
 * VenueResponse / HealthResponse). Hand-maintained — triangle-shows is a
 * plain FastAPI service outside the wxyc-shared codegen loop; the ETL's
 * `raw_data` column preserves the full payload so a drifted field is
 * recoverable without a re-pull.
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
  /** Single comma-joined string at the source, not a list. */
  support_artists: string | null;
  /** Venue-local calendar date, `YYYY-MM-DD`. */
  date: string;
  doors_time: string | null;
  show_time: string | null;
  ticket_url: string | null;
  price_min: number | null;
  price_max: number | null;
  image_url: string | null;
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
  updated_at: string | null;
  /** Soft tombstone: when the venue stopped advertising the event. */
  removed_at: string | null;
  // Denormalized venue fields joined into the event response.
  venue_name: string | null;
  venue_slug: string | null;
  venue_city: string | null;
  venue_color: string | null;
};

export type TsVenue = {
  id: number;
  name: string;
  slug: string;
  city: string;
  capacity: number | null;
  size_category: string;
  website: string | null;
  color: string;
};

export type TsHealth = {
  status: string;
  event_count: number;
  venue_count: number;
  /** Null when no scrape has run yet. */
  last_scrape: string | null;
  version: string | null;
};
