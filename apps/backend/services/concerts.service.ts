import { and, asc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { concerts, db, venues } from '@wxyc/database';

/**
 * Concerts read service — backs `GET /concerts` (BS#1603, touring-events
 * Phase 2). Pure DB reads over the `concerts`/`venues` tables that the
 * venue-events-scraper and triangle-shows ETL populate; no LML calls.
 *
 * Windowing rule: every predicate windows on `starts_on` (the NOT NULL
 * venue-local calendar date), never on `starts_at` — `starts_at` is null for
 * date-only events, and a range predicate on it would silently drop those
 * rows (SQL NULL semantics; see the `concerts` table JSDoc in
 * `shared/database/src/schema.ts`).
 */

/**
 * Wire shapes mirroring `Venue` / `Concert` / `ConcertsResponse` in
 * `wxyc-shared/api.yaml` v1.15.0 (the cross-repo SSOT). Local aliases pending
 * a published `@wxyc/shared` that carries them — once the dependency pin in
 * `apps/backend/package.json` reaches that version, these should be replaced
 * with `import type { Concert, Venue } from '@wxyc/shared/dtos'`. Same
 * sequencing as the flowsheet `on_air` field (emitted from a local shape
 * until the spec types published).
 */
export type VenueDTO = {
  id: number;
  slug: string;
  name: string;
  city: string;
  state: string;
  address: string | null;
};

export type ConcertDTO = {
  id: number;
  venue: VenueDTO;
  starts_on: string;
  // ISO-8601 date-time string (or null), matching the SSOT `Concert` type in
  // `wxyc-shared/api.yaml` (format: date-time). The Drizzle row surfaces these
  // as `Date`; `toConcertDTO` serializes them so the local alias aligns with
  // the generated `@wxyc/shared` shape (see the alias note above).
  starts_at: string | null;
  doors_at: string | null;
  headlining_artist_raw: string;
  headlining_artist_id: number | null;
  title: string | null;
  supporting_artists_raw: string[];
  ticket_url: string | null;
  image_url: string | null;
  price_min: number | null;
  price_max: number | null;
  age_restriction: string | null;
  status: 'on_sale' | 'sold_out' | 'cancelled' | 'rescheduled';
};

export type ConcertsQueryFilters = {
  /** Inclusive lower bound on `starts_on` (YYYY-MM-DD). */
  from: string;
  /** Inclusive upper bound on `starts_on` (YYYY-MM-DD); unbounded when absent. */
  to?: string;
  /** When true, only concerts whose headliner resolved to a catalog artist. */
  curated: boolean;
};

/**
 * Flat row produced by the explicit select below (concerts ⋈ venues).
 * Exported for the `toConcertDTO` unit tests.
 */
export type ConcertJoinRow = {
  id: number;
  starts_on: string;
  starts_at: Date | null;
  doors_at: Date | null;
  headlining_artist_raw: string;
  headlining_artist_id: number | null;
  title: string | null;
  supporting_artists_raw: string[];
  ticket_url: string | null;
  image_url: string | null;
  price_min: string | null;
  price_max: string | null;
  age_restriction: string | null;
  status: ConcertDTO['status'];
  venue_id: number;
  venue_slug: string;
  venue_name: string;
  venue_city: string;
  venue_state: string;
  venue_address: string | null;
};

// Explicit select list — the projection is the leak barrier: internal
// ingestion columns (source, source_id, raw_data, scraped_at,
// first_scraped_at, removed_at) are never selected, so they cannot reach the
// response no matter what the mapper does.
const concertJoinFields = {
  id: concerts.id,
  starts_on: concerts.starts_on,
  starts_at: concerts.starts_at,
  doors_at: concerts.doors_at,
  headlining_artist_raw: concerts.headlining_artist_raw,
  headlining_artist_id: concerts.headlining_artist_id,
  title: concerts.title,
  supporting_artists_raw: concerts.supporting_artists_raw,
  ticket_url: concerts.ticket_url,
  image_url: concerts.image_url,
  price_min: concerts.price_min,
  price_max: concerts.price_max,
  age_restriction: concerts.age_restriction,
  status: concerts.status,
  venue_id: venues.id,
  venue_slug: venues.slug,
  venue_name: venues.name,
  venue_city: venues.city,
  venue_state: venues.state,
  venue_address: venues.address,
};

/** Drizzle `numeric` columns surface as strings; the wire type is number. */
const toDollars = (price: string | null): number | null => (price === null ? null : Number(price));

/** Maps a flat concerts ⋈ venues row to the nested `Concert` wire shape. */
export const toConcertDTO = (row: ConcertJoinRow): ConcertDTO => ({
  id: row.id,
  venue: {
    id: row.venue_id,
    slug: row.venue_slug,
    name: row.venue_name,
    city: row.venue_city,
    state: row.venue_state,
    address: row.venue_address,
  },
  starts_on: row.starts_on,
  // Drizzle surfaces these `timestamptz` columns as `Date`; the SSOT wire
  // type is an ISO-8601 date-time string. `res.json` already serializes
  // Date→ISO, so the wire output is unchanged; this makes the DTO type honest.
  starts_at: row.starts_at === null ? null : row.starts_at.toISOString(),
  doors_at: row.doors_at === null ? null : row.doors_at.toISOString(),
  headlining_artist_raw: row.headlining_artist_raw,
  headlining_artist_id: row.headlining_artist_id,
  title: row.title,
  // Spec declares this a required non-null array; coalesce a NULL row value
  // to [] so a stray null can't break strict Swift/Kotlin decoders.
  supporting_artists_raw: row.supporting_artists_raw ?? [],
  ticket_url: row.ticket_url,
  image_url: row.image_url,
  price_min: toDollars(row.price_min),
  price_max: toDollars(row.price_max),
  age_restriction: row.age_restriction,
  status: row.status,
});

/**
 * Shared WHERE builder so the page and count queries can never drift.
 *
 * Non-removed rows only, windowed inclusively on `starts_on`. With
 * `curated: true` the predicate becomes exactly the
 * `concerts_curated_starts_on_idx` partial-index predicate
 * (`headlining_artist_id IS NOT NULL AND removed_at IS NULL`), so the
 * curated feed reads the index.
 */
const buildWhere = ({ from, to, curated }: ConcertsQueryFilters) => {
  const conditions = [isNull(concerts.removed_at), gte(concerts.starts_on, from)];
  if (to !== undefined) {
    conditions.push(lte(concerts.starts_on, to));
  }
  if (curated) {
    conditions.push(isNotNull(concerts.headlining_artist_id));
  }
  return and(...conditions);
};

/**
 * One page of upcoming concerts with their venues embedded, ordered by
 * `starts_on` ascending (id as a stable tiebreak).
 */
export const getConcertsPage = async (
  filters: ConcertsQueryFilters,
  limit: number,
  offset: number
): Promise<ConcertDTO[]> => {
  const rows = await db
    .select(concertJoinFields)
    .from(concerts)
    .innerJoin(venues, eq(venues.id, concerts.venue_id))
    .where(buildWhere(filters))
    .orderBy(asc(concerts.starts_on), asc(concerts.id))
    .limit(limit)
    .offset(offset);

  return (rows as ConcertJoinRow[]).map(toConcertDTO);
};

/** Total row count for the same filters, for `PaginationInfo`. */
export const getConcertsCount = async (filters: ConcertsQueryFilters): Promise<number> => {
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(concerts)
    .where(buildWhere(filters));

  return Number(result[0]?.count ?? 0);
};
