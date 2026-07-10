/**
 * DB writers for triangle-shows-etl. Two responsibilities, mirroring the
 * venue-events-scraper writer:
 *   1. Upsert the `venues` row for each ingested triangle-shows venue.
 *   2. Upsert `concerts` by the (source, source_id) unique constraint.
 *
 * Both use Drizzle's typed insert builder (BS#1068 array-binding trap,
 * BS#802 Date-serialization trap — see the RHP writer's docstring).
 *
 * Divergences from the RHP writer, both deliberate (BS#1589):
 *   - `status` IS refreshed on conflict. For source='triangle_shows' the
 *     source is authoritative in both directions (sold-out shows reopen
 *     when new tickets release). rhp_scrape keeps insert-only status
 *     because RHP's Offer.availability isn't trustworthy.
 *   - `removed_at` is written on both paths, including explicit null, so
 *     a reappearance CLEARS the tombstone.
 * Shared invariant: `first_scraped_at` stays out of both paths (BS#1385
 * INSERT-only stability anchor — the schema DEFAULT populates it).
 */

import { db, venues, concerts } from '@wxyc/database';
import { eq, sql } from 'drizzle-orm';

import type { MappedConcert } from './map.js';

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

/**
 * Resolve a venue slug to a numeric id, creating or refreshing the row.
 *
 * Source-authoritative on conflict (the RHP writer's "seeded" policy,
 * with triangle-shows as the seed): name/city/state refresh when any
 * differs, gated by `setWhere` so `last_modified` stays truthful. Admin
 * edits to name/city/state on these slugs WILL be reverted next run —
 * fix the data at the triangle-shows source instead. `address` is never
 * written (the source doesn't expose one), so an admin-entered address
 * survives.
 */
export const ensureVenue = async (slug: string, name: string, city: string): Promise<WriteVenueOutcome> => {
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
        state: 'NC',
        last_modified: sql`now()`,
      },
      setWhere: sql`${venues.name} IS DISTINCT FROM ${name}
          OR ${venues.city} IS DISTINCT FROM ${city}
          OR ${venues.state} IS DISTINCT FROM ${'NC'}`,
    })
    .returning({
      id: venues.id,
      created: sql<boolean>`xmax = 0`,
    });

  if (result.length > 0) {
    return { venue_id: result[0].id, created: result[0].created };
  }
  // setWhere suppressed the UPDATE (row already matches the source) and
  // no INSERT happened — look up the existing id.
  const existing = await db.select({ id: venues.id }).from(venues).where(eq(venues.slug, slug)).limit(1);
  if (existing.length === 0) {
    throw new Error(
      `ensureVenue: slug '${slug}' missing after upsert with no-op setWhere (row may have been deleted concurrently)`
    );
  }
  return { venue_id: existing[0].id, created: false };
};

/**
 * UPSERT one mapped concert. Idempotent on (source, source_id): the
 * venue-qualified key means a re-pull of the same snapshot is a pure
 * in-place UPDATE. Everything the source can change refreshes on
 * conflict — including `status` and `removed_at` (see module docstring)
 * — except `first_scraped_at` (BS#1385).
 */
export const upsertConcert = async (
  mapped: MappedConcert,
  venueId: number,
  scrapedAt: Date
): Promise<WriteConcertOutcome> => {
  const values: ConcertsValue = {
    source: 'triangle_shows',
    source_id: mapped.source_id,
    venue_id: venueId,
    starts_at: mapped.starts_at,
    starts_on: mapped.starts_on,
    doors_at: mapped.doors_at,
    headlining_artist_raw: mapped.headlining_artist_raw,
    title: mapped.title,
    supporting_artists_raw: mapped.supporting_artists_raw,
    status: mapped.status,
    price_min: mapped.price_min,
    price_max: mapped.price_max,
    age_restriction: mapped.age_restriction,
    ticket_url: mapped.ticket_url,
    image_url: mapped.image_url,
    removed_at: mapped.removed_at,
    raw_data: mapped.raw,
    scraped_at: scrapedAt,
  };

  const result = await db
    .insert(concerts)
    .values(values)
    .onConflictDoUpdate({
      target: [concerts.source, concerts.source_id],
      // `first_scraped_at` is deliberately absent from BOTH the values
      // above (schema DEFAULT now() populates it on INSERT) and this set
      // (so re-UPSERTs preserve the insert moment) — BS#1385.
      set: {
        venue_id: values.venue_id,
        starts_at: values.starts_at,
        starts_on: values.starts_on,
        doors_at: values.doors_at,
        headlining_artist_raw: values.headlining_artist_raw,
        // The concerts-artist-resolver is write-once (claims WHERE
        // headlining_artist_id IS NULL and never revisits a stamped row),
        // and ext:/url: source_keys survive renames — so when the raw
        // headliner actually changes under a stable key, the stale FK
        // must be cleared for the resolver to re-claim the row that same
        // night. Conditional on IS DISTINCT FROM so untouched rows keep
        // their resolved id.
        headlining_artist_id: sql`CASE WHEN ${concerts.headlining_artist_raw} IS DISTINCT FROM excluded."headlining_artist_raw" THEN NULL ELSE ${concerts.headlining_artist_id} END`,
        title: values.title,
        supporting_artists_raw: values.supporting_artists_raw,
        status: values.status,
        price_min: values.price_min,
        price_max: values.price_max,
        age_restriction: values.age_restriction,
        ticket_url: values.ticket_url,
        image_url: values.image_url,
        removed_at: values.removed_at,
        raw_data: values.raw_data,
        scraped_at: values.scraped_at,
        last_modified: sql`now()`,
      },
    })
    .returning({
      id: concerts.id,
      // xmax = 0 on the row this transaction INSERTed; non-zero when the
      // ON CONFLICT UPDATE path fired. Same idiom as the RHP writer.
      inserted: sql<boolean>`xmax = 0`,
    });

  const row = result[0];
  return { concert_id: row.id, inserted: row.inserted };
};
