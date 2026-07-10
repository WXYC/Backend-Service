/**
 * DB writers for venue-events-scraper. Two responsibilities:
 *   1. Seed/upsert the `venues` row for each venue slug we see.
 *   2. Upsert `concerts` by the (source, source_id) unique constraint.
 *
 * Both use Drizzle's typed insert builder rather than raw `sql\`\``
 * templates. The typed builder handles array binding safely (avoiding the
 * BS#1068 `'{...}'::text[]` literal trap) and routes Date / string
 * timestamps through Drizzle's date serializer (avoiding the BS#802 trap
 * where a Date passed through a raw template hit postgres-js's transparent
 * serializer and threw `ERR_INVALID_ARG_TYPE` inside `Buffer.byteLength()`).
 *
 * Per-call return values let the orchestrator accumulate counters without
 * threading state through the writer.
 */

import { db, venues, concerts, nyCalendarDate } from '@wxyc/database';
import { eq, sql } from 'drizzle-orm';

import type { ParsedConcert } from './rhp-types.js';
import { VENUE_SEEDS, type VenueSeed } from './rhp-venues.js';

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
 * Resolve a venue slug to a numeric id, creating the row if missing.
 *
 * Two distinct policies depending on whether the slug is in VENUE_SEEDS:
 *
 * - **Seeded** (canonical static data lives in `rhp-venues.ts`): on
 *   conflict, refresh name/city/state/address from the seed BUT only
 *   when at least one column actually differs from the row already in
 *   the table (via `setWhere`). This lifts a placeholder row that was
 *   inserted before the seed existed AND keeps `last_modified` truthful
 *   ("this row hasn't changed since X") instead of bumping it every
 *   nightly run. **Admin edits on a seeded slug WILL be reverted** the
 *   next time the scraper runs, because the setWhere predicate treats
 *   any divergence from the seed as "needs refresh". The workaround is
 *   to update the seed in `rhp-venues.ts`, not the row in the table.
 *
 * - **Unseeded** (a brand-new room the scraper hasn't been told about):
 *   INSERT if missing, otherwise DO NOTHING. We never overwrite an
 *   existing unseeded row from scrape inputs, because the scrape's
 *   `fallbackName / fallbackAddress` can be weaker than what the row
 *   already has (e.g. an earlier scrape captured a full street address
 *   that this scrape's JSON-LD omits) and because there's no
 *   admin-edit-protection flag on the table yet — so any operator who
 *   hand-corrects city/state/address must not lose their edit on the
 *   next nightly run. Recovery when a placeholder is just plain wrong
 *   (parser typo, location.name confused with headliner): either fix
 *   the row by manual SQL (it'll be preserved going forward) or promote
 *   the slug into VENUE_SEEDS so the seeded-path refresh takes over.
 *
 * `created` is computed from PG's `xmax = 0` predicate in the
 * seeded path (truthful under concurrent runners) and from the
 * presence/absence of a row in the unseeded INSERT … DO NOTHING
 * RETURNING result.
 *
 * Callers should cache the (slug → id) map across a single run to avoid
 * one round-trip per concert in the steady state.
 */
export const ensureVenue = async (
  slug: string,
  fallbackName: string,
  fallbackAddress: string | null
): Promise<WriteVenueOutcome> => {
  const seed = VENUE_SEEDS.find((s) => s.slug === slug);

  if (seed) {
    const seedValues: VenuesValue = {
      slug: seed.slug,
      name: seed.name,
      city: seed.city,
      state: seed.state,
      address: seed.address,
    };
    const result = await db
      .insert(venues)
      .values(seedValues)
      .onConflictDoUpdate({
        target: venues.slug,
        set: {
          name: seed.name,
          city: seed.city,
          state: seed.state,
          address: seed.address,
          last_modified: sql`now()`,
        },
        // Skip the UPDATE when nothing actually changed so `last_modified`
        // stays meaningful as an audit signal ('hasn't been touched
        // since X') rather than ticking every nightly run.
        setWhere: sql`${venues.name} IS DISTINCT FROM ${seed.name}
            OR ${venues.city} IS DISTINCT FROM ${seed.city}
            OR ${venues.state} IS DISTINCT FROM ${seed.state}
            OR ${venues.address} IS DISTINCT FROM ${seed.address}`,
      })
      .returning({
        id: venues.id,
        created: sql<boolean>`xmax = 0`,
      });

    if (result.length > 0) {
      const row = result[0];
      return { venue_id: row.id, created: row.created };
    }
    // setWhere predicate suppressed the UPDATE (nothing changed) AND no
    // INSERT happened (row already existed). Lookup the existing id.
    const existing = await db.select({ id: venues.id }).from(venues).where(eq(venues.slug, slug)).limit(1);
    if (existing.length === 0) {
      throw new Error(
        `ensureVenue: seeded slug '${slug}' missing after upsert with no-op setWhere (row may have been deleted concurrently)`
      );
    }
    return { venue_id: existing[0].id, created: false };
  }

  // Unseeded path: INSERT-or-preserve. Never overwrite a row we don't
  // own with potentially-weaker scrape inputs.
  const placeholderValues: VenuesValue = {
    slug,
    name: fallbackName,
    city: 'Unknown',
    state: 'NC',
    address: fallbackAddress,
  };
  const inserted = await db
    .insert(venues)
    .values(placeholderValues)
    .onConflictDoNothing({ target: venues.slug })
    .returning({ id: venues.id });
  if (inserted.length > 0) {
    return { venue_id: inserted[0].id, created: true };
  }
  const existing = await db.select({ id: venues.id }).from(venues).where(eq(venues.slug, slug)).limit(1);
  if (existing.length === 0) {
    throw new Error(
      `ensureVenue: unseeded slug '${slug}' missing after INSERT DO NOTHING (row may have been deleted concurrently)`
    );
  }
  return { venue_id: existing[0].id, created: false };
};

/**
 * Wrapper that caches venue lookups within a single scraper run. Reduces
 * per-concert DB round-trips from 1 to 0 once the cache is warm.
 */
export type VenueCache = {
  get: (slug: string, fallbackName: string, fallbackAddress: string | null) => Promise<number>;
  size: () => number;
};

export const makeVenueCache = (): VenueCache => {
  const cache = new Map<string, number>();
  return {
    async get(slug, fallbackName, fallbackAddress) {
      const hit = cache.get(slug);
      if (hit !== undefined) return hit;
      const { venue_id } = await ensureVenue(slug, fallbackName, fallbackAddress);
      cache.set(slug, venue_id);
      return venue_id;
    },
    size() {
      return cache.size;
    },
  };
};

/**
 * UPSERT one parsed concert. Idempotent on (source, source_id):
 * re-scraping the same URL updates the existing row rather than
 * creating a duplicate. `starts_at`, `ticket_url`, the supporting-acts
 * array, image, and raw payload all refresh on each pass so
 * reschedule / lineup-change / artwork-swap edits propagate.
 *
 * `status` is intentionally NOT touched on UPDATE. The schema defaults
 * a fresh row to `on_sale`, and the column is admin-managed thereafter
 * (sold_out / cancelled / rescheduled). The RHP JSON-LD's `Offer.availability`
 * isn't reliable enough to drive automated status transitions — adding
 * that pipeline is queued behind real cancellation data from the source
 * (tracked separately from this PR). Contrast: `jobs/triangle-shows-etl`
 * refreshes status on every upsert — its source maintains an explicit
 * status enum; see that job's README before assuming this insert-only
 * policy is a table-wide invariant.
 *
 * `scraped_at` is set per-call so the orchestrator can distinguish
 * "stamped this run" from "missed this run". A row that disappears from
 * the source's index entirely just stops getting refreshed — it isn't
 * deleted, since the venue removing a sold-out event from the calendar
 * is information we want to preserve (a future "past concerts" view
 * uses this).
 */
export const upsertConcert = async (
  parsed: ParsedConcert,
  venueId: number,
  scrapedAt: Date
): Promise<WriteConcertOutcome> => {
  const scrapedAtIso = scrapedAt.toISOString(); // Pre-stringify (BS#802 trap).

  const startsAt = new Date(parsed.starts_at);
  const values: ConcertsValue = {
    source: 'rhp_scrape',
    source_id: parsed.source_id,
    venue_id: venueId,
    starts_at: startsAt, // Drizzle typed builder serializes Date safely.
    // Venue-local calendar date (migration 0112 NOT NULL). In `set` below
    // too — a reschedule can move the calendar date.
    starts_on: nyCalendarDate(startsAt),
    headlining_artist_raw: parsed.headlining_artist,
    supporting_artists_raw: parsed.supporting_artists,
    ticket_url: parsed.ticket_url,
    image_url: parsed.image_url,
    raw_data: parsed.raw,
    scraped_at: new Date(scrapedAtIso),
  };

  const result = await db
    .insert(concerts)
    .values(values)
    .onConflictDoUpdate({
      target: [concerts.source, concerts.source_id],
      // INSERT-only: do NOT add `first_scraped_at` here. The schema's
      // DEFAULT now() populates it on INSERT; the omission from this
      // `set` is what keeps MIN(first_scraped_at) a forward-only
      // anchor (BS#1385). Contrast with `scraped_at`, which IS in `set`
      // below — every row's scraped_at refreshes on every run, so
      // MIN/MAX(scraped_at) both converge to "last successful sweep"
      // and can't answer "how long has the scraper been running?".
      // (`status` is also omitted, but for a separate reason — see the
      // docstring above. Don't conflate the two invariants.)
      set: {
        venue_id: values.venue_id,
        starts_at: values.starts_at,
        starts_on: values.starts_on,
        headlining_artist_raw: values.headlining_artist_raw,
        supporting_artists_raw: values.supporting_artists_raw,
        ticket_url: values.ticket_url,
        image_url: values.image_url,
        raw_data: values.raw_data,
        scraped_at: values.scraped_at,
        last_modified: sql`now()`,
      },
    })
    .returning({
      id: concerts.id,
      // Postgres system column `xmax` is 0 on the row that this transaction
      // INSERTed, and the deleter's xid (non-zero) on the row this
      // transaction UPDATEd via ON CONFLICT. The `xmax = 0` comparison
      // returns a real boolean and postgres-js parses bool to JS boolean,
      // so no driver-side cast is needed here.
      inserted: sql<boolean>`xmax = 0`,
    });

  const row = result[0];
  return { concert_id: row.id, inserted: row.inserted };
};

export type { VenueSeed };
