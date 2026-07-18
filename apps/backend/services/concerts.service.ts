import { and, asc, eq, gte, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  artist_metadata,
  artist_similar_artists,
  artists,
  concerts,
  db,
  normalizeFreetextArtist,
  type SimilarArtistNeighbor,
  venues,
} from '@wxyc/database';
import { LRUCache } from 'lru-cache';
import * as Sentry from '@sentry/node';

/**
 * Concerts read service — backs `GET /concerts` (BS#1603, on-tour
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
 * `wxyc-shared/api.yaml` v1.17.0 (the cross-repo SSOT). Local aliases pending
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
  // The venue's own event-detail page (BS#1609). Distinct from ticket_url
  // (often a third-party seller); the iOS CTA prefers this when non-null.
  event_url: string | null;
  price_min: number | null;
  price_max: number | null;
  age_restriction: string | null;
  status: 'on_sale' | 'sold_out' | 'cancelled' | 'rescheduled';
  // Discogs genre tags for the resolved headlining artist (BS#1624, On Tour
  // R2), sourced from `artist_metadata` via a null-safe LEFT JOIN. Null when
  // the headliner is unresolved OR the nightly genre enrichment hasn't run.
  // Optional (not in the api.yaml `required` set — wxyc-shared#221) so the
  // field can land ahead of any consumer and older clients decode forward-
  // compatibly; mirrored here as `genres?` to keep the compile-time
  // `Equal<ConcertDTO, ApiYamlConcert>` pin in concerts.service.test.ts honest.
  genres?: string[] | null;
  // Top-K affinity neighbors of the resolved headlining artist (BS#1626, On Tour
  // R3b), sourced from `artist_similar_artists` via a null-safe LEFT JOIN on
  // `headlining_artist_id`. Each `{ artist_id, weight }` is in the WXYC catalog
  // keyspace (same as `headlining_artist_id`), so on-device For You matching
  // intersects it against liked-artist ids in one id space. Null when the
  // headliner has no in-library id OR the nightly enrichment hasn't run. Same
  // optional-and-nullable discipline as `genres` (wxyc-shared#222).
  similar_artists?: SimilarArtistNeighbor[] | null;
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
  event_url: string | null;
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
  // Optional: only the `getConcertsPage` projection LEFT-joins `artist_metadata`
  // and selects this. The `getUpcomingShowsMaps` projection omits it, so its
  // rows leave it undefined and `toConcertDTO` coalesces to null.
  genres?: string[] | null;
  // Optional: only the `getConcertsPage` projection LEFT-joins
  // `artist_similar_artists` and selects this. The `getUpcomingShowsMaps` embed
  // omits it (the #1616 hot-path guard), so its rows leave it undefined and
  // `toConcertDTO` coalesces to null.
  similar_artists?: SimilarArtistNeighbor[] | null;
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
  event_url: concerts.event_url,
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
  event_url: row.event_url,
  price_min: toDollars(row.price_min),
  price_max: toDollars(row.price_max),
  age_restriction: row.age_restriction,
  status: row.status,
  // Null-safe: a projection that doesn't LEFT-join `artist_metadata` (the
  // `upcoming_show` embed) leaves `genres` undefined → null on the wire; a
  // resolved-but-unenriched headliner surfaces as null too (no joined row).
  genres: row.genres ?? null,
  // Same null-safe discipline (BS#1626): undefined on the embed projection,
  // null for a headliner with no in-library id or no enrichment row.
  similar_artists: row.similar_artists ?? null,
});

/**
 * Shared WHERE builder so the page and count queries can never drift.
 *
 * Non-removed rows only, windowed inclusively on `starts_on`. With
 * `curated: true` the predicate becomes exactly the
 * `concerts_curated_starts_on_idx` partial-index predicate
 * (`(headlining_artist_id IS NOT NULL OR headlining_discogs_artist_id IS
 * NOT NULL) AND removed_at IS NULL`), so the curated feed reads the index.
 * Either resolution lane counts as curated (BS#1614): the catalog FK from
 * the strict/alias resolver, or the Discogs id minted by the offline LML
 * pass for touring artists absent from the library. The OR must stay an
 * exact twin of the index predicate in shared/database/src/schema.ts —
 * widening one without the other silently de-indexes the curated feed.
 */
const buildWhere = ({ from, to, curated }: ConcertsQueryFilters) => {
  const conditions = [isNull(concerts.removed_at), gte(concerts.starts_on, from)];
  if (to !== undefined) {
    conditions.push(lte(concerts.starts_on, to));
  }
  if (curated) {
    conditions.push(or(isNotNull(concerts.headlining_artist_id), isNotNull(concerts.headlining_discogs_artist_id))!);
  }
  return and(...conditions);
};

/**
 * The headliner's effective Discogs artist id, keyed off whichever resolution
 * lane stamped the concert: the offline LML pass writes
 * `concerts.headlining_discogs_artist_id` directly (BS#1614), while a
 * library-resolved headliner reaches its Discogs id through
 * `artists.discogs_artist_id`. When both are present they agree (the LML pass
 * FK-loop-closes on the singleton `artists.discogs_artist_id` match), so the
 * COALESCE order is immaterial in that case. This is the exact key
 * `jobs/concerts-genre-enrichment/` writes `artist_metadata` rows under, so the
 * projection and the enrichment SELECT resolve genres through the same
 * expression.
 */
const effectiveHeadlinerDiscogsId = sql`COALESCE(${concerts.headlining_discogs_artist_id}, ${artists.discogs_artist_id})`;

// Page projection: the shared concerts⋈venues fields plus the LEFT-joined
// artist-level genres (BS#1624) and affinity neighbors (BS#1626). Kept separate
// from `concertJoinFields` so the `getUpcomingShowsMaps` / count paths (which
// don't join `artist_metadata` / `artist_similar_artists`) can't accidentally
// reference those tables' columns.
const concertPageFields = {
  ...concertJoinFields,
  genres: artist_metadata.genres,
  similar_artists: artist_similar_artists.neighbors,
};

/**
 * One page of upcoming concerts with their venues embedded, ordered by
 * `starts_on` ascending (id as a stable tiebreak).
 *
 * Genres projection (BS#1624): a LEFT JOIN to `artists` (to reach a library
 * headliner's `discogs_artist_id`) and a LEFT JOIN to `artist_metadata` on the
 * effective Discogs id. Both are LEFT joins so an unresolved or un-enriched
 * headliner keeps the row and surfaces `genres: null` — never dropped.
 *
 * Similar-artists projection (BS#1626): a LEFT JOIN to `artist_similar_artists`
 * on `headlining_artist_id` directly — a clean catalog FK, no Discogs COALESCE
 * needed, because the affinity graph is keyed on the library artist id. LEFT so
 * a headliner with no in-library id or no enrichment row surfaces
 * `similar_artists: null`. Purely additive to the BS#1603 shape; no existing
 * field's behavior changes.
 */
export const getConcertsPage = async (
  filters: ConcertsQueryFilters,
  limit: number,
  offset: number
): Promise<ConcertDTO[]> => {
  const rows = await db
    .select(concertPageFields)
    .from(concerts)
    .innerJoin(venues, eq(venues.id, concerts.venue_id))
    .leftJoin(artists, eq(artists.id, concerts.headlining_artist_id))
    .leftJoin(artist_metadata, eq(artist_metadata.discogs_artist_id, effectiveHeadlinerDiscogsId))
    .leftJoin(artist_similar_artists, eq(artist_similar_artists.artist_id, concerts.headlining_artist_id))
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

/**
 * Single-concert read backing the public `GET /concerts/:id` (BS#1694, On
 * Tour sharing; contract `wxyc-shared/api.yaml` v1.18.0, wxyc-shared#236).
 * Reuses the list's exact projection (`concertPageFields`, BS#1624 genres
 * LEFT JOIN included) and the same `toConcertDTO` mapper, so the by-id wire
 * shape can never drift from `getConcertsPage`'s.
 *
 * Deliberately WINDOWLESS — the one place `buildWhere` is NOT used: no
 * `starts_on` bound and no `removed_at IS NULL` conjunct. The share page and
 * the iOS universal-link fallback render past and source-delisted
 * (tombstoned) shows as "this one's passed" with whatever `status` the row
 * last carried, so those rows must come back rather than 404. The leak
 * barrier is untouched: the explicit select list never includes `removed_at`
 * or the other ingestion columns, so a tombstoned row is served without
 * exposing that it is one.
 *
 * Resolves null when no row matches (or when the venue INNER JOIN drops a
 * dangling `venue_id` — same strictness as the list; a Concert without its
 * embedded Venue can't satisfy the contract). The controller maps null → 404.
 */
export const getConcertById = async (id: number): Promise<ConcertDTO | null> => {
  const rows = await db
    .select(concertPageFields)
    .from(concerts)
    .innerJoin(venues, eq(venues.id, concerts.venue_id))
    .leftJoin(artists, eq(artists.id, concerts.headlining_artist_id))
    .leftJoin(artist_metadata, eq(artist_metadata.discogs_artist_id, effectiveHeadlinerDiscogsId))
    .where(eq(concerts.id, id))
    .limit(1);

  const row = (rows as ConcertJoinRow[])[0];
  return row === undefined ? null : toConcertDTO(row);
};

/**
 * Adds the canonical catalog artist name to the concerts ⋈ venues projection
 * for the `upcoming_show` name arm. Sourced via the LEFT JOIN to `artists`, so
 * a resolved concert keys its name-map entry off the artist's CURRENT catalog
 * name (which may differ from the possibly-stale scraped raw), while an
 * unresolved concert leaves this null and falls back to the raw.
 */
const upcomingShowJoinFields = {
  ...concertJoinFields,
  artist_name: artists.artist_name,
};

/** `ConcertJoinRow` plus the LEFT-joined canonical artist name (null when unresolved). */
type UpcomingShowJoinRow = ConcertJoinRow & { artist_name: string | null };

/**
 * Batched upcoming-concert lookup backing the V2 flowsheet feed's per-playcut
 * `upcoming_show` enrichment (BS#1607, widened by BS#1613; on-tour
 * Phase 3).
 *
 * ONE indexed query for a whole feed page — never one query per row. The caller
 * (`flowsheet.service` `attachUpcomingShows`) invokes this once and fans the
 * two returned maps back onto the page's tracks. This is the no-N+1 guarantee
 * the ticket and the post-launch hardening posture (project #32) require.
 *
 * JOIN shape:
 *   - INNER JOIN `venues` — strict, exactly as `getConcertsPage`; keeps the
 *     DTO's `venue` non-null. A concert with a dangling `venue_id` is dropped
 *     (it can't render a CTA anyway).
 *   - LEFT JOIN `artists` on `headlining_artist_id` — only to source the
 *     canonical name for the name arm's key. It MUST be a left join: an inner
 *     join would drop every UNRESOLVED concert (`headlining_artist_id IS
 *     NULL`), which is precisely the set BS#1613's name arm exists to recover.
 *
 * Predicate: `buildWhere({ from: today, curated: false })` — `removed_at IS NULL
 * AND starts_on >= today` (America/New_York, supplied by the caller so the
 * window matches `GET /concerts`'s `todayEastern`). Reusing the shared builder
 * keeps this feed from drifting off the page/count queries; `curated: false`
 * omits the `headlining_artist_id IS NOT NULL` conjunct — unlike BS#1607's
 * id-only lookup, this must include unresolved concerts. Reads the
 * `concerts_active_starts_on_id_idx` (non-tombstoned, `starts_on`-first).
 *
 * Returns two maps, each collapsed to the SOONEST concert per key by
 * first-write-wins over rows ordered `starts_on ASC, id ASC` (id as a stable
 * tiebreak when two dates coincide) — mirroring the "soonest wins" rule on the
 * `upcoming_show` DTO without a `DISTINCT ON`:
 *   - `byArtistId` — RESOLVED rows only (`headlining_artist_id` non-null),
 *     keyed by that id. The precise arm; matches album-linked plays.
 *   - `byNormName` — keyed by `normalizeFreetextArtist(...)` (the free-text
 *     match SSOT: `normalizeArtistName` + collapse internal whitespace + trim,
 *     so incidental spacing in a scraped raw or a DJ's free-text entry can't
 *     split the key): the canonical `artists.artist_name` for a resolved row
 *     (so a free-text play typed with the current name matches even when the
 *     concert resolved via an alias of an older name), else the scraped
 *     `headlining_artist_raw`. Both sides of the match run this one function, so
 *     the two keys are provably drift-free. A billing/co-bill raw normalizes to
 *     its ENTIRE string — an inert key no one-artist-per-entry flowsheet play
 *     equals — so it is stored but never matched (see the BS#1613 ticket's "no
 *     clean-name filter" rationale). RESIDUAL (accepted; #1614 is the real
 *     lever): two DISTINCT artists sharing a normalized name (homonyms, e.g. two
 *     bands named `Wire`) collapse to one key — the soonest wins and can attach
 *     to a play of the other. Low-harm for a "On Tour" CTA, not engineered
 *     around here.
 *
 * The venue-embedding join and DTO mapping reuse `getConcertsPage`'s projection
 * so the wire shape can't drift.
 */
export const getUpcomingShowsMaps = async (
  today: string
): Promise<{ byArtistId: Map<number, ConcertDTO>; byNormName: Map<string, ConcertDTO> }> => {
  const byArtistId = new Map<number, ConcertDTO>();
  const byNormName = new Map<string, ConcertDTO>();

  const rows = await db
    .select(upcomingShowJoinFields)
    .from(concerts)
    .innerJoin(venues, eq(venues.id, concerts.venue_id))
    .leftJoin(artists, eq(artists.id, concerts.headlining_artist_id))
    .where(buildWhere({ from: today, curated: false }))
    .orderBy(asc(concerts.starts_on), asc(concerts.id));

  for (const row of rows as UpcomingShowJoinRow[]) {
    const artistId = row.headlining_artist_id;

    // name arm — canonical name for resolved rows (falling back to the raw only
    // on the impossible dangling-FK miss, since `artists.artist_name` is NOT
    // NULL), the scraped raw for unresolved rows.
    const nameSource = artistId !== null && row.artist_name !== null ? row.artist_name : row.headlining_artist_raw;
    const nameKey = normalizeFreetextArtist(nameSource);

    // First write wins per key → the soonest date (rows arrive starts_on ASC).
    // id arm is resolved rows only; name arm skips the inert empty key.
    const needsId = artistId !== null && !byArtistId.has(artistId);
    const needsName = nameKey !== '' && !byNormName.has(nameKey);
    if (!needsId && !needsName) {
      continue; // a later date for an already-seen artist AND name — build no DTO
    }

    const dto = toConcertDTO(row);
    if (needsId && artistId !== null) {
      byArtistId.set(artistId, dto);
    }
    if (needsName) {
      byNormName.set(nameKey, dto);
    }
  }

  return { byArtistId, byNormName };
};

/** Resolved return of {@link getUpcomingShowsMaps}, aliased for the cache below. */
type UpcomingShowsMaps = Awaited<ReturnType<typeof getUpcomingShowsMaps>>;

/**
 * Per-process cache of the two `upcoming_show` maps (BS#1616).
 *
 * {@link getUpcomingShowsMaps} runs on the hot V2 flowsheet read path — including
 * `getLatest`, the single-entry "now playing" tick the iOS/Android apps and the
 * uptime canary poll continuously — and each call scans the entire unbounded
 * upcoming-concerts set (`removed_at IS NULL AND starts_on >= today`, no upper
 * bound) to rebuild the maps. This cache amortizes that: continuous polling
 * collapses from one full-catalog scan PER read to ~one rebuild per TTL.
 *
 * Keyed on the ET `today` string (`nyCalendarDate`, supplied by the caller), so a
 * midnight roll produces a miss and rebuilds rather than serving a just-passed
 * show as upcoming. `max: 2` holds today plus a briefly-overlapping yesterday
 * across the roll; `ttl: 60_000` keeps the amortization benefit (~1 rebuild/min
 * regardless of poll rate) while surfacing a rare manual concert edit within a
 * minute — `concerts` otherwise mutates only via the nightly ETL, so intra-day
 * staleness cost is ~zero.
 *
 * The cached VALUE is the `Promise<Maps>`, not the resolved maps, so concurrent
 * cold callers atomically share one in-flight build (the get/set is synchronous
 * on Node's single thread). A rejected build is evicted, never cached (see the
 * wrapper). Per-process only — like the LML lookup coordinator's cache,
 * cross-instance coalescing is out of scope; session stickiness collapses most
 * same-key bursts.
 */
const upcomingShowsMapsCache = new LRUCache<string, Promise<UpcomingShowsMaps>>({
  max: 2,
  ttl: 60_000,
});

/**
 * Cached wrapper around {@link getUpcomingShowsMaps} for the hot read path
 * (`flowsheet.service` `attachUpcomingShows`). A cold miss builds and `.set`s the
 * in-flight promise synchronously so concurrent callers coalesce onto it; a warm
 * hit returns the settled promise for the rest of the TTL.
 *
 * INVARIANT — the returned maps, and the `ConcertDTO` instances inside them, are
 * handed out BY REFERENCE to every caller within the TTL and MUST be treated as
 * read-only. The sole consumer, `attachUpcomingShows`, only reads them (it shares
 * a `ConcertDTO` onto `entry.upcoming_show`; `transformToV2` spreads it into a
 * fresh response object and never mutates it). Never mutate a returned map or DTO.
 *
 * Error handling: the ORIGINAL promise is returned, so a build failure rejects to
 * the caller (→ Express error handler) exactly as the uncached builder did. A
 * SEPARATE `.catch` evicts the rejected entry so the error is not cached — the
 * next call issues a fresh query. Both consumers handle the rejection, so there
 * is no unhandled-rejection footgun.
 */
export const getUpcomingShowsMapsCached = (today: string): Promise<UpcomingShowsMaps> => {
  const hit = upcomingShowsMapsCache.get(today);
  // Boolean attribute is safe via the late setAttribute path (the numeric
  // string-typing trap of BS#1070/#1081 only affects avg/p50 aggregations on
  // numbers). Lets prod confirm getLatest's hit ratio — i.e. that it stopped
  // scanning `concerts` on every poll.
  Sentry.getActiveSpan()?.setAttribute('concerts.upcoming_maps.cache_hit', hit !== undefined);
  if (hit !== undefined) {
    return hit;
  }
  const build = getUpcomingShowsMaps(today);
  upcomingShowsMapsCache.set(today, build);
  build.catch(() => upcomingShowsMapsCache.delete(today)); // evict on failure; never cache an error
  return build;
};

/**
 * Test-only hook to clear the module-scoped cache between cases — mirrors the
 * `__reset…ForTests` helpers in `library.service` / `proxy.controller`. Any suite
 * that exercises the real wrapper (the cache unit tests; the out-of-process
 * integration spec, via the test-gated `/internal/test/reset-upcoming-shows-cache`
 * endpoint) must reset it, or a warm entry leaks a prior case's maps.
 */
export function __resetUpcomingShowsMapsCacheForTests(): void {
  upcomingShowsMapsCache.clear();
}
