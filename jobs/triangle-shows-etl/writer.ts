/**
 * DB writers for triangle-shows-etl. Same shape as the RHP scraper's
 * writer (typed insert builder — the BS#1068 `'{...}'::text[]` literal
 * trap and the BS#802 Date-through-raw-template trap both only bite raw
 * `sql\`\`` templates), with two deliberate policy differences:
 *
 *  1. `status` refreshes on EVERY upsert, both directions. The RHP
 *     writer's status is insert-only/admin-managed because JSON-LD
 *     `Offer.availability` is unreliable; triangle-shows maintains an
 *     explicit per-event status enum refreshed by its per-venue platform
 *     scrapers, so for these rows the source is strictly better-informed
 *     than a BS admin.
 *  2. `removed_at` mirrors the source's tombstone both directions — set
 *     when stamped, CLEARED when a delisted event reappears. Absence
 *     from the snapshot is never a removal signal (source rows hard-
 *     delete 7 days past their date; `starts_on` windowing retires them).
 *
 * `first_scraped_at` stays INSERT-only (omitted from `values` and the ON
 * CONFLICT `set`), matching the RHP writer's BS#1385 anchor.
 *
 * Venue policy: single path, source-authoritative. Every ingested venue
 * comes from triangle-shows' own venue list (real municipalities per
 * triangle-shows#10), so on conflict we refresh name/city from the
 * source — but only when something actually differs (`setWhere`), so
 * `last_modified` stays truthful. Admin edits on these rows WILL be
 * reverted by the next run; the fix-it-upstream venue data lives in
 * triangle-shows' seed.
 */

import { db, venues, concerts } from '@wxyc/database';
import { eq, sql } from 'drizzle-orm';

import { clampCodePoints, type MappedEvent } from './map.js';

type VenuesValue = typeof venues.$inferInsert;
type ConcertsValue = typeof concerts.$inferInsert;

export type WriteVenueOutcome = {
  venue_id: number;
  created: boolean;
};

export type WriteConcertOutcome = {
  concert_id: number;
  inserted: boolean;
};

/** `venues.slug` is varchar(64) — a key, so overflow throws rather than
 *  truncates (a clipped slug would silently alias two venues). */
const VENUE_SLUG_MAX = 64;
/** `venues.name` is varchar(128); the source allows String(200). A display
 *  name clamps safely — PG errors rather than truncates, and one long-named
 *  venue must not drop its whole calendar from the mirror. */
const VENUE_NAME_MAX = 128;

/**
 * Resolve a venue slug to a numeric id, creating or refreshing the row
 * from source data. `state` is hardcoded 'NC' — every triangle-shows
 * venue is in the Triangle. `created` derives from PG's `xmax = 0`.
 *
 * Width guards live HERE, at the single write chokepoint, so the
 * on-demand provisioning path is covered too — `assertVenuePartition`'s
 * startup check only sees the /venues list, not event-denormalized names.
 */
export const ensureVenue = async (slug: string, rawName: string, city: string): Promise<WriteVenueOutcome> => {
  if (slug.length > VENUE_SLUG_MAX) {
    throw new Error(
      `ensureVenue: slug '${slug.slice(0, 80)}…' exceeds venues.slug varchar(${VENUE_SLUG_MAX}) — ` +
        `a source-side slug change past the column width; do not truncate a key`
    );
  }
  const name = clampCodePoints(rawName, VENUE_NAME_MAX);
  const values: VenuesValue = {
    slug,
    name,
    city,
    state: 'NC',
  };
  const result = await db
    .insert(venues)
    .values(values)
    .onConflictDoUpdate({
      target: venues.slug,
      set: {
        name,
        city,
        last_modified: sql`now()`,
      },
      // Skip the UPDATE when nothing changed so `last_modified` stays an
      // honest audit signal instead of ticking every nightly run.
      setWhere: sql`${venues.name} IS DISTINCT FROM ${name}
          OR ${venues.city} IS DISTINCT FROM ${city}`,
    })
    .returning({
      id: venues.id,
      created: sql<boolean>`xmax = 0`,
    });

  if (result.length > 0) {
    return { venue_id: result[0].id, created: result[0].created };
  }
  // setWhere suppressed the UPDATE (nothing changed) and no INSERT
  // happened (row already existed). Look up the existing id.
  const existing = await db.select({ id: venues.id }).from(venues).where(eq(venues.slug, slug)).limit(1);
  if (existing.length === 0) {
    throw new Error(
      `ensureVenue: slug '${slug}' missing after upsert with no-op setWhere (row may have been deleted concurrently)`
    );
  }
  return { venue_id: existing[0].id, created: false };
};

/** Per-run (slug -> id) cache: one DB round-trip per venue per run. The
 *  only POSITIVE memoization layer — the orchestrator adds a negative
 *  side (its `failedSlugs` set skips venues whose provisioning already
 *  failed this run) but keeps no second id map. `created` is threaded
 *  through (false on cache hits) so the orchestrator can surface
 *  brand-new venue rows as the re-check-the-RHP-partition signal. */
export type VenueCache = {
  get: (slug: string, name: string, city: string) => Promise<WriteVenueOutcome>;
  size: () => number;
};

export const makeVenueCache = (): VenueCache => {
  const cache = new Map<string, number>();
  return {
    async get(slug, name, city) {
      const hit = cache.get(slug);
      if (hit !== undefined) return { venue_id: hit, created: false };
      const outcome = await ensureVenue(slug, name, city);
      cache.set(slug, outcome.venue_id);
      return outcome;
    },
    size() {
      return cache.size;
    },
  };
};

/**
 * UPSERT one mapped event. Idempotent on (source, source_id) — the
 * venue-qualified `'<venue_slug>:' + source_key`. Every content column
 * refreshes on each pass, INCLUDING `status` and `removed_at` (see the
 * module docstring for why this deliberately diverges from the RHP
 * writer) and EXCLUDING `first_scraped_at` (INSERT-only anchor).
 */
export const upsertConcert = async (
  mapped: MappedEvent,
  venueId: number,
  scrapedAt: Date
): Promise<WriteConcertOutcome> => {
  const values: ConcertsValue = {
    ...mapped.concert,
    venue_id: venueId,
    scraped_at: scrapedAt, // Already a Date; the typed builder serializes it safely.
  };

  const result = await db
    .insert(concerts)
    .values(values)
    .onConflictDoUpdate({
      target: [concerts.source, concerts.source_id],
      // INSERT-only: `first_scraped_at` is deliberately absent — the
      // schema's DEFAULT now() populates it on INSERT and its omission
      // here preserves the forward-only anchor (BS#1385).
      set: {
        venue_id: values.venue_id,
        starts_on: values.starts_on,
        starts_at: values.starts_at,
        doors_at: values.doors_at,
        headlining_artist_raw: values.headlining_artist_raw,
        title: values.title,
        supporting_artists_raw: values.supporting_artists_raw,
        ticket_url: values.ticket_url,
        image_url: values.image_url,
        price_min: values.price_min,
        price_max: values.price_max,
        age_restriction: values.age_restriction,
        // Source-authoritative, both directions (divergence from
        // rhp_scrape's insert-only status — see module docstring).
        status: values.status,
        // Mirrors the tombstone both directions: a null here CLEARS a
        // previously-set removed_at when the event reappears.
        removed_at: values.removed_at,
        raw_data: values.raw_data,
        scraped_at: values.scraped_at,
        last_modified: sql`now()`,
      },
    })
    .returning({
      id: concerts.id,
      // xmax = 0 on the row this transaction INSERTed; non-zero when the
      // ON CONFLICT UPDATE path fired.
      inserted: sql<boolean>`xmax = 0`,
    });

  const row = result[0];
  return { concert_id: row.id, inserted: row.inserted };
};
