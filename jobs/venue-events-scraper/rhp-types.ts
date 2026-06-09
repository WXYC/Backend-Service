/**
 * Types for the JSON-LD payload RHP sites embed in each event page, plus
 * the normalized shape the orchestrator carries between fetch and write.
 *
 * Schema.org's Event shape is permissive — fields can be missing,
 * strings or objects, single values or arrays. We narrow defensively in
 * the parser; this file declares the *expected* shape so the parser can
 * fail fast (and the writer can rely on the narrowed type).
 */

/** Minimal subset of schema.org `Place` we read from. */
export type SchemaPlace = {
  '@type': 'Place';
  name?: string;
  address?: string | { '@type'?: string; streetAddress?: string };
};

/** Minimal subset of schema.org `Offer` we read from. */
export type SchemaOffer = {
  '@type': 'Offer';
  url?: string;
  price?: number | string;
  priceCurrency?: string;
  availability?: string;
};

/** Minimal subset of schema.org `Event` we read from. */
export type SchemaEvent = {
  '@context'?: string;
  // schema.org permits `@type` to be a single string OR an array of
  // strings (multi-typing pattern, e.g. `["Event","MusicEvent"]`).
  '@type': 'Event' | 'MusicEvent' | ReadonlyArray<string>;
  name: string;
  startDate: string;
  url?: string;
  image?: string | string[];
  location?: SchemaPlace;
  offers?: SchemaOffer | SchemaOffer[];
};

/**
 * Normalized concert record emitted by the parser, consumed by the
 * writer. Mirrors the `concerts` table schema closely so the writer is
 * a thin INSERT.
 */
export type ParsedConcert = {
  /** Site we scraped (matches RhpVenueConfig.site_slug). */
  site_slug: string;
  /** Per-source unique identifier — the event page's path. */
  source_id: string;
  /** URL of the event detail page on the venue's site. */
  event_page_url: string;
  /** Slug into `venues` table. */
  venue_slug: string;
  /** Display name from JSON-LD `location.name` (HTML-decoded). */
  venue_name: string | null;
  /** Free-text address from JSON-LD `location.address`. */
  venue_address: string | null;
  headlining_artist: string;
  supporting_artists: string[];
  /** ISO 8601 string with timezone offset, as RHP emits it. */
  starts_at: string;
  ticket_url: string | null;
  image_url: string | null;
  /** The full parsed JSON-LD Event object, for forensics. */
  raw: SchemaEvent;
};
