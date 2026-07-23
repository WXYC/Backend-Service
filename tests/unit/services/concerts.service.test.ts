/**
 * Unit tests for the concerts read service (BS#1603, BS#1694).
 *
 * `@wxyc/database` resolves to tests/mocks/database.mock.ts, so these pin
 * the pieces that don't need PostgreSQL:
 *   - `toConcertDTO` — nested venue embedding, numeric→number price
 *     conversion, null passthrough, and (the leak barrier) the exact wire
 *     key set: no internal ingestion columns.
 *   - The select projection never references the internal columns, so they
 *     can't reach the response regardless of the mapper.
 *   - `getConcertById` — first-row → DTO via the same mapper as the list,
 *     empty → null, and the shared leak-barrier projection.
 *
 * Windowing behavior (date-only rows, curated predicate, pagination against
 * real SQL) is covered by tests/integration/concerts.spec.js; the by-id
 * read's WINDOWLESS semantics (past + tombstoned rows served) are covered by
 * tests/integration/concerts-by-id.spec.js.
 */
import { db } from '@wxyc/database';
import {
  ConcertDTO,
  ConcertJoinRow,
  __resetUpcomingShowsMapsCacheForTests,
  getConcertById,
  getConcertsCount,
  getConcertsPage,
  getUpcomingShowsMaps,
  getUpcomingShowsMapsCached,
  toConcertDTO,
} from '../../../apps/backend/services/concerts.service';

/**
 * Compile-time pin: `ConcertDTO` must match the SSOT `Concert` schema in
 * `wxyc-shared/api.yaml` v1.21.0 (station_recommended_rank added in 1.21.0 /
 * BS#1756, wxyc-shared#248). The published `@wxyc/shared` at this worktree's pin
 * (`^2.3.0`) does not yet export a `Concert` DTO, so we
 * assert against a hand-mirrored shape derived from the api.yaml operation.
 * When `@wxyc/shared` publishes `Concert`, replace `ApiYamlConcert` below
 * with `import type { Concert } from '@wxyc/shared/dtos'` — the two-way
 * `Equal` assertions then fail loudly if the local alias drifts from the
 * SSOT (`date-time` fields are strings, `supporting_artists_raw` non-null,
 * prices numbers, status the closed enum).
 */
type ApiYamlConcertVenue = {
  id: number;
  slug: string;
  name: string;
  city: string;
  state: string;
  address: string | null;
};

type ApiYamlConcert = {
  id: number;
  venue: ApiYamlConcertVenue;
  starts_on: string;
  starts_at: string | null;
  doors_at: string | null;
  headlining_artist_raw: string;
  headlining_artist_id: number | null;
  title: string | null;
  supporting_artists_raw: string[];
  ticket_url: string | null;
  image_url: string | null;
  event_url: string | null;
  price_min: number | null;
  price_max: number | null;
  age_restriction: string | null;
  status: 'on_sale' | 'sold_out' | 'cancelled' | 'rescheduled';
  // BS#1624 / wxyc-shared#221: nullable AND optional (not in the api.yaml
  // `required` set), so `genres?: string[] | null`.
  genres?: string[] | null;
  // BS#1734 / wxyc-shared#247: raw Discogs artist bio, same optional +
  // nullable discipline as `genres`.
  artist_bio?: string | null;
  // BS#1626 / wxyc-shared#222: the `SimilarArtist` schema (`{ artist_id, weight }`)
  // as an optional + nullable array, same discipline as `genres`.
  similar_artists?: { artist_id: number; weight: number }[] | null;
  // BS#1702: the station-affinity play count as an optional + nullable integer,
  // same discipline as `genres`/`similar_artists`.
  station_plays?: number | null;
  // BS#1731 (wxyc-shared#244): rotation-membership signal for the "For You"
  // station-affinity tier. Optional, NOT nullable — the page/by-id projection's
  // EXISTS always yields a concrete boolean; only the embed omits the key.
  station_recommended?: boolean;
  // BS#1756 (wxyc-shared#248): 1-based rank within the station_recommended set,
  // ordered by all-time WXYC plays. Optional + nullable, same discipline as
  // `station_plays` (its structural twin) — NOT `station_recommended`'s
  // non-null boolean.
  station_recommended_rank?: number | null;
};

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// Fails to compile if ConcertDTO and the api.yaml-derived shape diverge in
// either direction (extra key, missing key, or type mismatch).
type _ConcertDtoMatchesSsot = Expect<Equal<ConcertDTO, ApiYamlConcert>>;
// Reference the alias so `noUnusedLocals`/lint keep the assertion live.
const _concertDtoTypeGuard: _ConcertDtoMatchesSsot = true;

const mockDb = db as unknown as { _chain: Record<string, jest.Mock> };

const INTERNAL_COLUMNS = ['source', 'source_id', 'raw_data', 'scraped_at', 'first_scraped_at', 'removed_at'];

const timedRow: ConcertJoinRow = {
  id: 101,
  starts_on: '2026-08-14',
  starts_at: new Date('2026-08-15T00:00:00.000Z'),
  doors_at: new Date('2026-08-14T23:00:00.000Z'),
  headlining_artist_raw: 'Nilüfer Yanya',
  headlining_artist_id: 4211,
  title: null,
  supporting_artists_raw: ['Hermanos Gutiérrez'],
  ticket_url: 'https://www.etix.com/ticket/p/nilufer-yanya',
  image_url: 'https://catscradle.com/img/nilufer-yanya.jpg',
  event_url: 'https://catscradle.com/event/nilufer-yanya/',
  price_min: '25.00',
  price_max: '28.50',
  age_restriction: 'All Ages',
  status: 'on_sale',
  venue_id: 3,
  venue_slug: 'cats-cradle',
  venue_name: "Cat's Cradle",
  venue_city: 'Carrboro',
  venue_state: 'NC',
  venue_address: '300 E Main St, Carrboro, NC 27510',
  // Resolved + enriched headliner: the LEFT JOIN to `artist_metadata` produced
  // a genres array (BS#1624).
  genres: ['Rock', 'Electronic'],
  // Resolved + enriched headliner: the same LEFT JOIN produced a raw Discogs
  // bio (BS#1734).
  artist_bio: 'Nilüfer Yanya is a British singer-songwriter and guitarist from London.',
  // Resolved + enriched headliner: the LEFT JOIN to `artist_similar_artists`
  // produced an affinity-neighbor array (BS#1626).
  similar_artists: [
    { artist_id: 5121, weight: 4.83 },
    { artist_id: 88, weight: 2.1 },
  ],
  // Resolved + enriched headliner: the LEFT JOIN to `artist_station_plays`
  // produced an all-time play count (BS#1702).
  station_plays: 312,
  // Resolved headliner with a rotation-linked library release (BS#1731).
  station_recommended: true,
  // Gated (station_recommended: true): the correlated subquery placed it 1st
  // in the station-recommended set (BS#1756).
  station_recommended_rank: 1,
};

const dateOnlyRow: ConcertJoinRow = {
  ...timedRow,
  id: 102,
  starts_on: '2026-09-01',
  starts_at: null,
  doors_at: null,
  headlining_artist_id: null,
  title: 'Csillagrablók with special guests',
  supporting_artists_raw: [],
  ticket_url: null,
  image_url: null,
  event_url: null,
  price_min: null,
  price_max: null,
  age_restriction: null,
  venue_address: null,
  // Unresolved headliner (headlining_artist_id null): the LEFT JOINs miss, so
  // the projection yields NULL genres, artist_bio, similar_artists, and
  // station_plays.
  genres: null,
  artist_bio: null,
  similar_artists: null,
  station_plays: null,
  // Unresolved headliner: the EXISTS correlation never matches → false (BS#1731).
  station_recommended: false,
  // Not gated (station_recommended: false): outside the ranked set → null (BS#1756).
  station_recommended_rank: null,
};

describe('ConcertDTO structural pin', () => {
  it('matches the api.yaml-derived Concert shape (compile-time assertion)', () => {
    // The real check is the `_ConcertDtoMatchesSsot` type above, which fails
    // to compile on drift; this keeps a runtime reference to the guard.
    expect(_concertDtoTypeGuard).toBe(true);
  });
});

describe('toConcertDTO', () => {
  it('embeds the full venue object', () => {
    const dto = toConcertDTO(timedRow);
    expect(dto.venue).toEqual({
      id: 3,
      slug: 'cats-cradle',
      name: "Cat's Cradle",
      city: 'Carrboro',
      state: 'NC',
      address: '300 E Main St, Carrboro, NC 27510',
    });
  });

  it('converts numeric price strings to numbers', () => {
    const dto = toConcertDTO(timedRow);
    expect(dto.price_min).toBe(25);
    expect(dto.price_max).toBe(28.5);
  });

  it('serializes Date instants to ISO-8601 strings (SSOT date-time shape)', () => {
    const dto = toConcertDTO(timedRow);
    expect(dto.starts_at).toBe('2026-08-15T00:00:00.000Z');
    expect(dto.doors_at).toBe('2026-08-14T23:00:00.000Z');
    expect(typeof dto.starts_at).toBe('string');
  });

  it('passes nulls through for a date-only row (null starts_at)', () => {
    const dto = toConcertDTO(dateOnlyRow);
    expect(dto.starts_on).toBe('2026-09-01');
    expect(dto.starts_at).toBeNull();
    expect(dto.doors_at).toBeNull();
    expect(dto.headlining_artist_id).toBeNull();
    expect(dto.price_min).toBeNull();
    expect(dto.price_max).toBeNull();
    expect(dto.venue.address).toBeNull();
  });

  // BS#1609 — event_url is the venue event page, distinct from ticket_url. It
  // passes through verbatim (present or null); a null lets iOS fall back to
  // ticket_url exactly as before the field existed.
  it('passes event_url through, distinct from ticket_url', () => {
    const dto = toConcertDTO(timedRow);
    expect(dto.event_url).toBe('https://catscradle.com/event/nilufer-yanya/');
    expect(dto.event_url).not.toBe(dto.ticket_url);
  });

  it('emits a null event_url for a row with no known venue page', () => {
    expect(toConcertDTO(dateOnlyRow).event_url).toBeNull();
  });

  it('coalesces a NULL supporting_artists_raw to an empty array', () => {
    // Spec says the column is non-null, but a defensive coalesce guards
    // against a stray NULL breaking strict Swift/Kotlin decoders.
    const nulled = { ...timedRow, supporting_artists_raw: null as unknown as string[] };
    const dto = toConcertDTO(nulled);
    expect(dto.supporting_artists_raw).toEqual([]);
  });

  // BS#1624 — genres come from the LEFT JOIN to artist_metadata. Present for a
  // resolved + enriched headliner; null when the headliner is unresolved or the
  // enrichment hasn't run.
  it('passes the joined genres array through for a resolved, enriched headliner', () => {
    const dto = toConcertDTO(timedRow);
    expect(dto.genres).toEqual(['Rock', 'Electronic']);
  });

  it('emits null genres for an unresolved headliner (LEFT JOIN miss)', () => {
    expect(toConcertDTO(dateOnlyRow).genres).toBeNull();
  });

  it('coalesces an undefined row.genres (projection without the join) to null', () => {
    const { genres: _drop, ...withoutGenres } = timedRow;
    void _drop;
    const dto = toConcertDTO(withoutGenres);
    expect(dto.genres).toBeNull();
  });

  // BS#1734 — artist_bio comes from the same LEFT JOIN to artist_metadata as
  // genres. Present for a resolved + enriched headliner; null when unresolved
  // or the enrichment hasn't run.
  it('passes the joined artist_bio through for a resolved, enriched headliner', () => {
    const dto = toConcertDTO(timedRow);
    expect(dto.artist_bio).toBe('Nilüfer Yanya is a British singer-songwriter and guitarist from London.');
  });

  it('emits null artist_bio for an unresolved headliner (LEFT JOIN miss)', () => {
    expect(toConcertDTO(dateOnlyRow).artist_bio).toBeNull();
  });

  it('coalesces an undefined row.artist_bio (projection without the join) to null', () => {
    const { artist_bio: _drop, ...withoutBio } = timedRow;
    void _drop;
    const dto = toConcertDTO(withoutBio);
    expect(dto.artist_bio).toBeNull();
  });

  // BS#1626 — similar_artists come from the LEFT JOIN to artist_similar_artists.
  // Present for a resolved + enriched headliner; null when unresolved or the
  // enrichment hasn't run; null when the embed projection omits the join.
  it('passes the joined similar_artists array through for a resolved, enriched headliner', () => {
    const dto = toConcertDTO(timedRow);
    expect(dto.similar_artists).toEqual([
      { artist_id: 5121, weight: 4.83 },
      { artist_id: 88, weight: 2.1 },
    ]);
  });

  it('emits null similar_artists for an unresolved headliner (LEFT JOIN miss)', () => {
    expect(toConcertDTO(dateOnlyRow).similar_artists).toBeNull();
  });

  it('coalesces an undefined row.similar_artists (embed projection without the join) to null', () => {
    const { similar_artists: _drop, ...without } = timedRow;
    void _drop;
    const dto = toConcertDTO(without);
    expect(dto.similar_artists).toBeNull();
  });

  // BS#1702 — station_plays comes from the LEFT JOIN to artist_station_plays.
  // Present for a resolved + enriched headliner; null when unresolved or the
  // enrichment hasn't run; null when the embed projection omits the join.
  it('passes the joined station_plays count through for a resolved, enriched headliner', () => {
    const dto = toConcertDTO(timedRow);
    expect(dto.station_plays).toBe(312);
  });

  it('emits null station_plays for an unresolved headliner (LEFT JOIN miss)', () => {
    expect(toConcertDTO(dateOnlyRow).station_plays).toBeNull();
  });

  it('coalesces an undefined row.station_plays (embed projection without the join) to null', () => {
    const { station_plays: _drop, ...without } = timedRow;
    void _drop;
    const dto = toConcertDTO(without);
    expect(dto.station_plays).toBeNull();
  });

  // BS#1756 — station_recommended_rank comes from the correlated-subquery
  // expression in the page/by-id projection: present for a gated headliner,
  // null for one outside the gated set, and null (not undefined) when the
  // embed projection omits the expression — same null-safe discipline as
  // `station_plays`, its structural twin.
  it('passes the joined station_recommended_rank through for a gated headliner', () => {
    const dto = toConcertDTO(timedRow);
    expect(dto.station_recommended_rank).toBe(1);
  });

  it('emits null station_recommended_rank for a non-gated headliner', () => {
    expect(toConcertDTO(dateOnlyRow).station_recommended_rank).toBeNull();
  });

  it('coalesces an undefined row.station_recommended_rank (embed projection without the expression) to null', () => {
    const { station_recommended_rank: _drop, ...without } = timedRow;
    void _drop;
    const dto = toConcertDTO(without);
    expect(dto.station_recommended_rank).toBeNull();
  });

  // BS#1731 — station_recommended comes from the EXISTS(rotation ⋈ library)
  // subquery in the page/by-id projection: true for a rotation-linked resolved
  // headliner, false for an unrotated or unresolved one, and OMITTED (not
  // coalesced to false) when the embed projection doesn't select it.
  it('passes station_recommended: true through for a rotation-linked headliner', () => {
    const dto = toConcertDTO(timedRow);
    expect(dto.station_recommended).toBe(true);
  });

  it('passes station_recommended: false through for an unrotated/unresolved headliner', () => {
    const dto = toConcertDTO(dateOnlyRow);
    expect(dto.station_recommended).toBe(false);
  });

  it('omits station_recommended (not false) when the row lacks the key (embed projection)', () => {
    const { station_recommended: _drop, ...without } = timedRow;
    void _drop;
    const dto = toConcertDTO(without);
    expect(dto.station_recommended).toBeUndefined();
    expect(JSON.parse(JSON.stringify(dto))).not.toHaveProperty('station_recommended');
  });

  it('emits exactly the Concert wire keys — no internal ingestion columns', () => {
    const dto = toConcertDTO(timedRow);
    expect(Object.keys(dto).sort()).toEqual(
      [
        'id',
        'venue',
        'starts_on',
        'starts_at',
        'doors_at',
        'headlining_artist_raw',
        'headlining_artist_id',
        'title',
        'supporting_artists_raw',
        'ticket_url',
        'image_url',
        'event_url',
        'price_min',
        'price_max',
        'age_restriction',
        'status',
        'genres',
        'artist_bio',
        'similar_artists',
        'station_plays',
        'station_recommended',
        'station_recommended_rank',
      ].sort()
    );
    for (const internal of INTERNAL_COLUMNS) {
      expect(dto).not.toHaveProperty(internal);
    }
  });
});

describe('getConcertsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('selects a projection that never references internal columns', async () => {
    // Terminal .offset() resolves the row set for this call.
    mockDb._chain.offset.mockReturnValueOnce(Promise.resolve([timedRow]));

    const result = await getConcertsPage({ from: '2026-08-01', curated: false }, 50, 0);

    expect(result).toEqual([toConcertDTO(timedRow)]);
    // The mocked table objects map each column to its name, so the
    // projection's values are column-name strings we can inspect.
    const projection = mockDb._chain.select.mock.calls[0][0] as Record<string, string>;
    const selectedColumns = Object.values(projection);
    for (const internal of INTERNAL_COLUMNS) {
      expect(selectedColumns).not.toContain(internal);
    }
    // BS#1731 — the station_recommended EXISTS is part of the shared page
    // projection, so it must always be selected here.
    expect(Object.keys(projection)).toContain('station_recommended');
    // BS#1756 — the station_recommended_rank correlated subquery is part of
    // the shared page projection too, so it must always be selected here.
    expect(Object.keys(projection)).toContain('station_recommended_rank');
  });
});

describe('getConcertsCount', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the count from the first row', async () => {
    // Terminal .where() resolves the aggregate row for this call.
    mockDb._chain.where.mockReturnValueOnce(Promise.resolve([{ count: 42 }]));
    await expect(getConcertsCount({ from: '2026-08-01', curated: false })).resolves.toBe(42);
  });

  it('returns 0 when the aggregate row is missing', async () => {
    mockDb._chain.where.mockReturnValueOnce(Promise.resolve([]));
    await expect(getConcertsCount({ from: '2026-08-01', curated: true })).resolves.toBe(0);
  });
});

/**
 * BS#1694 — single-concert read behind the public `GET /concerts/:id`. The
 * load-bearing property here is SHAPE PARITY with the list: the same
 * projection and the same `toConcertDTO` mapper, asserted by comparing the
 * result to `toConcertDTO(row)` rather than to hand-written literals. The
 * windowless half of the contract (no `starts_on` bound, no `removed_at`
 * filter) is real-SQL behavior, pinned in
 * tests/integration/concerts-by-id.spec.js.
 */
describe('getConcertById', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps the found row through toConcertDTO — the exact list serialization', async () => {
    // Terminal .limit(1) resolves the row set for this call.
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([timedRow]));

    await expect(getConcertById(101)).resolves.toEqual(toConcertDTO(timedRow));
  });

  it('resolves null when no row matches the id', async () => {
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([]));

    await expect(getConcertById(999999)).resolves.toBeNull();
  });

  // `concerts.id` is an int4 serial, so ids outside (0, 2^31-1] — and
  // non-integers — can never match a row. The service owns that persistence
  // fact and short-circuits to null BEFORE the query: the Postgres int4 bind
  // would otherwise reject the value ("integer out of range") as an unhandled
  // 500, and the service's `id: number` signature must stay total for
  // non-route callers (the share-page BFF chain) that skip the controller's
  // parse guard.
  it.each([
    ['int4 max + 1', 2_147_483_648],
    ['far beyond int4', 99_999_999_999_999],
    ['zero', 0],
    ['negative', -7],
    ['non-integer', 3.5],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('short-circuits an impossible id (%s) to null without querying', async (_label, id) => {
    await expect(getConcertById(id)).resolves.toBeNull();

    expect(mockDb._chain.select).not.toHaveBeenCalled();
  });

  it('selects the shared list projection — never the internal ingestion columns', async () => {
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([timedRow]));

    await getConcertById(101);

    const projection = mockDb._chain.select.mock.calls[0][0] as Record<string, string>;
    const selectedColumns = Object.values(projection);
    for (const internal of INTERNAL_COLUMNS) {
      expect(selectedColumns).not.toContain(internal);
    }
    // Parity pin: the by-id projection carries the BS#1624 genres, BS#1734
    // artist_bio, BS#1702 station_plays, BS#1731 station_recommended, and
    // BS#1756 station_recommended_rank fields, so a by-id read can never lag
    // the list's enrichment fields (the BS#1694 lockstep-join invariant).
    expect(Object.keys(projection)).toContain('genres');
    expect(Object.keys(projection)).toContain('artist_bio');
    expect(Object.keys(projection)).toContain('station_plays');
    expect(Object.keys(projection)).toContain('station_recommended');
    expect(Object.keys(projection)).toContain('station_recommended_rank');
  });
});

/**
 * BS#1613 widens the `upcoming_show` match from the id-only join to a hybrid
 * id-arm ∪ name-arm. `getUpcomingShowsMaps` loads every upcoming, non-tombstoned
 * concert once (not filtered to a passed id list) and returns two maps:
 *   - `byArtistId` — resolved rows only, keyed by `headlining_artist_id`;
 *   - `byNormName` — resolved rows keyed by the CANONICAL artist name (from the
 *     LEFT JOIN to `artists`), unresolved rows keyed by the raw. Billing-string
 *     raws normalize to their entire string — inert keys, not false positives.
 * Both maps are first-write-wins over rows ordered `starts_on ASC, id`, so each
 * key holds the SOONEST upcoming concert.
 *
 * These fixtures carry the extra `artist_name` (the canonical name the LEFT
 * JOIN sources) that `ConcertJoinRow` doesn't; the row shape is a superset.
 *
 * BS#1761 adds a SECOND pass (support acts) after this one, reading
 * `concert_performers` — see the sibling `describe('getUpcomingShowsMaps
 * support arm (BS#1761)', ...)` block below for those tests. This suite pins
 * PASS 1 (headliners) only and is otherwise unchanged, so every test here
 * queues an additional empty `orderBy` result for Pass 2's query (its rows
 * never affect a headliner-only scenario, per the "only add where absent"
 * precedence rule).
 */
describe('getUpcomingShowsMaps (BS#1613)', () => {
  type UpcomingRow = ConcertJoinRow & { artist_name: string | null };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Resolved: headlining_artist_id set; artist_name is the canonical catalog
  // name, which can differ from the scraped raw (here, diacritic vs not).
  const resolvedRow: UpcomingRow = {
    ...timedRow,
    id: 301,
    headlining_artist_id: 4211,
    headlining_artist_raw: 'Nilufer Yanya', // scraped, no diacritic
    artist_name: 'Nilüfer Yanya', // canonical catalog name
    starts_on: '2026-08-14',
  };

  // Unresolved, clean single name (the recall #1613 adds): keys off the raw.
  const unresolvedCleanRow: UpcomingRow = {
    ...timedRow,
    id: 302,
    headlining_artist_id: null,
    headlining_artist_raw: 'Wishy',
    artist_name: null,
    starts_on: '2026-08-20',
  };

  // Unresolved billing string: keys off its ENTIRE normalized string — inert.
  const billingRow: UpcomingRow = {
    ...timedRow,
    id: 303,
    headlining_artist_id: null,
    headlining_artist_raw: 'Circle Jerks & Municipal Waste',
    artist_name: null,
    starts_on: '2026-08-22',
  };

  it('builds byArtistId from resolved rows only, keyed by headlining_artist_id', async () => {
    mockDb._chain.orderBy
      .mockReturnValueOnce(Promise.resolve([resolvedRow, unresolvedCleanRow])) // pass 1: headliners
      .mockReturnValueOnce(Promise.resolve([])); // pass 2: no support rows
    const { byArtistId } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.size).toBe(1); // the unresolved row is not in the id map
    expect(byArtistId.get(4211)).toEqual(toConcertDTO(resolvedRow));
  });

  it('keys a resolved row in byNormName off the CANONICAL name, not the raw', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([resolvedRow])).mockReturnValueOnce(Promise.resolve([]));
    const { byNormName } = await getUpcomingShowsMaps('2026-08-01');
    // canonical 'Nilüfer Yanya' → 'nilüfer yanya'; the diacritic-free raw
    // 'Nilufer Yanya' → 'nilufer yanya' is NOT the key.
    expect(byNormName.get('nilüfer yanya')).toEqual(toConcertDTO(resolvedRow));
    expect(byNormName.has('nilufer yanya')).toBe(false);
  });

  it('keys an unresolved clean row in byNormName off the raw name', async () => {
    mockDb._chain.orderBy
      .mockReturnValueOnce(Promise.resolve([unresolvedCleanRow]))
      .mockReturnValueOnce(Promise.resolve([]));
    const { byArtistId, byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.size).toBe(0); // unresolved → absent from the id map
    expect(byNormName.get('wishy')).toEqual(toConcertDTO(unresolvedCleanRow));
  });

  it('keys a billing-string raw off its ENTIRE normalized string (inert key)', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([billingRow])).mockReturnValueOnce(Promise.resolve([]));
    const { byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byNormName.get('circle jerks & municipal waste')).toEqual(toConcertDTO(billingRow));
    // The individual acts are NOT keys, so a single-artist play can't match.
    expect(byNormName.has('circle jerks')).toBe(false);
    expect(byNormName.has('municipal waste')).toBe(false);
  });

  it('collapses stray + doubled whitespace in the name key (free-text SSOT)', async () => {
    // A DJ free-text play and a scraped raw routinely differ only in incidental
    // whitespace ('J Dilla' vs 'J  Dilla' vs ' J Dilla '). The name arm keys
    // free-text plays, so it must use the free-text normalizer (collapse internal
    // whitespace + trim) — the same SSOT `flowsheet_freetext_resolution` uses —
    // not the bare `normalizeArtistName`, which leaves the doubled/edge spaces in
    // place and silently splits the key.
    const messy: UpcomingRow = {
      ...unresolvedCleanRow,
      id: 402,
      headlining_artist_raw: ' J  Dilla ',
      starts_on: '2026-08-11',
    };
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([messy])).mockReturnValueOnce(Promise.resolve([]));
    const { byNormName } = await getUpcomingShowsMaps('2026-08-01');
    // Collapsed + trimmed → a play typed 'J Dilla' (single space) matches.
    expect(byNormName.get('j dilla')).toEqual(toConcertDTO(messy));
    // The un-collapsed variant is NOT a key (would be a silent no-match).
    expect(byNormName.has(' j  dilla ')).toBe(false);
  });

  it('collapses multiple dates for one name key to the SOONEST (first row wins)', async () => {
    // Rows arrive ordered starts_on ASC (the query's ORDER BY), so the first
    // occurrence of a key is the soonest.
    const soon: UpcomingRow = { ...unresolvedCleanRow, id: 400, starts_on: '2026-08-10' };
    const later: UpcomingRow = { ...unresolvedCleanRow, id: 401, starts_on: '2026-09-10' };
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([soon, later])).mockReturnValueOnce(Promise.resolve([]));
    const { byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byNormName.get('wishy')).toEqual(toConcertDTO(soon));
  });

  it('collapses multiple dates for one artist id to the SOONEST (first row wins)', async () => {
    const soon: UpcomingRow = { ...resolvedRow, id: 500, starts_on: '2026-08-10' };
    const later: UpcomingRow = { ...resolvedRow, id: 501, starts_on: '2026-09-10' };
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([soon, later])).mockReturnValueOnce(Promise.resolve([]));
    const { byArtistId } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.get(4211)).toEqual(toConcertDTO(soon));
  });

  it('LEFT JOINs artists so a resolved row can source its canonical name', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([])).mockReturnValueOnce(Promise.resolve([]));
    await getUpcomingShowsMaps('2026-08-01');
    // The join to artists must be a LEFT join — an INNER join would silently
    // drop every unresolved concert (headlining_artist_id IS NULL), which is
    // exactly the set the name arm exists to recover.
    expect(mockDb._chain.leftJoin).toHaveBeenCalled();
  });

  it('never selects internal ingestion columns', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([])).mockReturnValueOnce(Promise.resolve([]));
    await getUpcomingShowsMaps('2026-08-01');
    // Pass 1's (headliner) projection is the first db.select call.
    const projection = mockDb._chain.select.mock.calls[0][0] as Record<string, string>;
    const selectedColumns = Object.values(projection);
    for (const internal of INTERNAL_COLUMNS) {
      expect(selectedColumns).not.toContain(internal);
    }
  });

  it('returns two empty maps for an empty upcoming set', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([])).mockReturnValueOnce(Promise.resolve([]));
    const { byArtistId, byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.size).toBe(0);
    expect(byNormName.size).toBe(0);
  });
});

/**
 * BS#1761 — PASS 2 of `getUpcomingShowsMaps`: support acts. Reads active
 * (non-tombstoned) `concert_performers` rows with `role = 'support'`, joined
 * to the SAME upcoming/non-tombstoned `concerts` window as Pass 1, ordered
 * `starts_on ASC, concerts.id ASC` (a `concert_performers.id` tiebreak for
 * several support rows on ONE concert — see the production doc comment for
 * why that tie is harmless: every support row on a given concert maps to the
 * SAME `toConcertDTO` output regardless of which one is processed first).
 *
 * Precedence proof: Pass 1 runs to completion (fully populates both maps)
 * BEFORE Pass 2 evaluates a single row, so `!byArtistId.has(...)` /
 * `!byNormName.has(...)` can only be true when NO headliner — of ANY upcoming
 * date — claimed that key. That is the entire "headliner beats support
 * regardless of date" rule; no date comparison against the headliner's date
 * is needed or performed.
 *
 * Each test here queues an EMPTY Pass 1 result (unless a test explicitly
 * needs a competing headliner) followed by the Pass 2 fixture rows.
 */
describe('getUpcomingShowsMaps support arm (BS#1761)', () => {
  // Row shape Pass 2 selects: the shared concert⋈venue fields plus the
  // junction's raw_name and (resolved-or-null) artist_id — see
  // `concertJoinFields` reuse in the production `getUpcomingShowsMaps`.
  type SupportRow = ConcertJoinRow & { raw_name: string; support_artist_id: number | null };
  // Pass-1 fixture shape (mirrors the sibling BS#1613 describe block's
  // `UpcomingRow`), needed here only for the precedence tests that seed a
  // competing headliner row.
  type HeadlinerRow = ConcertJoinRow & { artist_name: string | null };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // A RESOLVED support act (concert_performers.artist_id set), no competing headliner.
  const resolvedSupport: SupportRow = {
    ...timedRow,
    id: 701,
    headlining_artist_id: null,
    headlining_artist_raw: 'Some Unrelated Headliner',
    starts_on: '2026-08-16',
    raw_name: 'Kelela',
    support_artist_id: 850,
  };

  // An UNRESOLVED support act: a clean single name (post-parseBilling), no artist_id.
  const unresolvedSupport: SupportRow = {
    ...timedRow,
    id: 702,
    headlining_artist_id: null,
    headlining_artist_raw: 'A Different Headliner',
    starts_on: '2026-08-18',
    raw_name: 'Carmen Villain',
    support_artist_id: null,
  };

  it('adds a resolved support to byArtistId when no headliner has claimed the key', async () => {
    mockDb._chain.orderBy
      .mockReturnValueOnce(Promise.resolve([])) // pass 1: no headliners
      .mockReturnValueOnce(Promise.resolve([resolvedSupport])); // pass 2
    const { byArtistId } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.get(850)).toEqual(toConcertDTO(resolvedSupport));
  });

  it('adds an unresolved support to byNormName keyed off its raw name', async () => {
    mockDb._chain.orderBy
      .mockReturnValueOnce(Promise.resolve([]))
      .mockReturnValueOnce(Promise.resolve([unresolvedSupport]));
    const { byArtistId, byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.size).toBe(0); // unresolved — absent from the id map
    expect(byNormName.get('carmen villain')).toEqual(toConcertDTO(unresolvedSupport));
  });

  it('adds a RESOLVED support to byNormName too, keyed off the RAW name (not a canonical/artists-joined name)', async () => {
    // Deliberate divergence from Pass 1's headliner arm: the support name arm
    // always keys off concert_performers.raw_name — resolved or not — never a
    // canonical `artists.artist_name` substitution. `raw_name` is already a
    // clean single name post-parseBilling, so no `artists` join is needed.
    mockDb._chain.orderBy
      .mockReturnValueOnce(Promise.resolve([]))
      .mockReturnValueOnce(Promise.resolve([resolvedSupport]));
    const { byArtistId, byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.get(850)).toEqual(toConcertDTO(resolvedSupport));
    expect(byNormName.get('kelela')).toEqual(toConcertDTO(resolvedSupport));
  });

  it('a headliner beats a support for the SAME id key regardless of date (later headliner, earlier support)', async () => {
    const laterHeadliner: HeadlinerRow = {
      ...timedRow,
      id: 703,
      headlining_artist_id: 850,
      headlining_artist_raw: 'Headliner Billing',
      artist_name: 'Headliner Canonical',
      starts_on: '2026-09-20', // LATER than the support's date
    };
    const earlierSupport: SupportRow = { ...resolvedSupport, starts_on: '2026-08-05' }; // EARLIER
    mockDb._chain.orderBy
      .mockReturnValueOnce(Promise.resolve([laterHeadliner])) // pass 1
      .mockReturnValueOnce(Promise.resolve([earlierSupport])); // pass 2
    const { byArtistId } = await getUpcomingShowsMaps('2026-08-01');
    // The LATER headliner wins the key even though the support's date is sooner.
    expect(byArtistId.get(850)).toEqual(toConcertDTO(laterHeadliner));
  });

  it('a headliner beats a support for the SAME name key regardless of date (later headliner, earlier support)', async () => {
    const laterHeadliner: HeadlinerRow = {
      ...timedRow,
      id: 704,
      headlining_artist_id: null, // unresolved: name arm keys off the raw
      headlining_artist_raw: 'Colleen',
      artist_name: null,
      starts_on: '2026-09-22', // LATER
    };
    const earlierSupport: SupportRow = {
      ...unresolvedSupport,
      raw_name: 'Colleen', // same normalized key as the headliner's raw
      starts_on: '2026-08-06', // EARLIER
    };
    mockDb._chain.orderBy
      .mockReturnValueOnce(Promise.resolve([laterHeadliner]))
      .mockReturnValueOnce(Promise.resolve([earlierSupport]));
    const { byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byNormName.get('colleen')).toEqual(toConcertDTO(laterHeadliner));
  });

  it('collapses multiple support dates for the SAME id key to the SOONEST (first write wins within support)', async () => {
    const soon: SupportRow = { ...resolvedSupport, id: 705, starts_on: '2026-08-05' };
    const later: SupportRow = { ...resolvedSupport, id: 706, starts_on: '2026-09-05' };
    mockDb._chain.orderBy
      .mockReturnValueOnce(Promise.resolve([])) // pass 1: no headliners
      .mockReturnValueOnce(Promise.resolve([soon, later])); // pass 2, ordered starts_on ASC
    const { byArtistId } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.get(850)).toEqual(toConcertDTO(soon));
  });

  it('collapses multiple support dates for the SAME name key to the SOONEST (first write wins within support)', async () => {
    const soon: SupportRow = { ...unresolvedSupport, id: 707, starts_on: '2026-08-07' };
    const later: SupportRow = { ...unresolvedSupport, id: 708, starts_on: '2026-09-07' };
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([])).mockReturnValueOnce(Promise.resolve([soon, later]));
    const { byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byNormName.get('carmen villain')).toEqual(toConcertDTO(soon));
  });

  it('skips a support row entirely once a headliner already claims BOTH its id key and its name key', async () => {
    const headliner: HeadlinerRow = {
      ...timedRow,
      id: 709,
      headlining_artist_id: 860,
      headlining_artist_raw: 'Anjimile',
      artist_name: 'Anjimile',
      starts_on: '2026-08-09',
    };
    const support: SupportRow = {
      ...resolvedSupport,
      id: 710,
      support_artist_id: 860,
      raw_name: 'Anjimile',
      starts_on: '2026-08-02', // even sooner — must still lose on BOTH arms
    };
    mockDb._chain.orderBy
      .mockReturnValueOnce(Promise.resolve([headliner]))
      .mockReturnValueOnce(Promise.resolve([support]));
    const { byArtistId, byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.get(860)).toEqual(toConcertDTO(headliner));
    expect(byNormName.get('anjimile')).toEqual(toConcertDTO(headliner));
  });

  it('is a no-op when there are no active support rows (byte-identical to pre-1761 output)', async () => {
    const headliner: HeadlinerRow = { ...timedRow, id: 711, artist_name: 'Nilüfer Yanya' };
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([headliner])).mockReturnValueOnce(Promise.resolve([])); // pass 2: nothing active
    const { byArtistId, byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.get(4211)).toEqual(toConcertDTO(headliner));
    expect(byNormName.get('nilüfer yanya')).toEqual(toConcertDTO(headliner));
    expect(byArtistId.size).toBe(1);
    expect(byNormName.size).toBe(1);
  });

  it('collapses stray + doubled whitespace in the support name key (free-text SSOT — same normalizer as Pass 1)', async () => {
    const messy: SupportRow = { ...unresolvedSupport, id: 712, raw_name: ' Carmen  Villain ' };
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([])).mockReturnValueOnce(Promise.resolve([messy]));
    const { byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byNormName.get('carmen villain')).toEqual(toConcertDTO(messy));
    expect(byNormName.has(' carmen  villain ')).toBe(false);
  });

  it('never selects internal ingestion columns in the support-pass projection', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([])).mockReturnValueOnce(Promise.resolve([]));
    await getUpcomingShowsMaps('2026-08-01');
    // Pass 2's (support) projection is the second db.select call.
    const projection = mockDb._chain.select.mock.calls[1][0] as Record<string, string>;
    const selectedColumns = Object.values(projection);
    for (const internal of INTERNAL_COLUMNS) {
      expect(selectedColumns).not.toContain(internal);
    }
  });
});

/**
 * BS#1616 — `getUpcomingShowsMaps` runs on the hot V2 flowsheet read path
 * (including `getLatest`, the single-entry "now playing" tick the iOS/Android
 * apps and the uptime canary poll continuously), and each call scans the entire
 * unbounded upcoming-concerts set to rebuild the two maps.
 * `getUpcomingShowsMapsCached` wraps the pure builder in a per-process,
 * promise-valued LRU keyed on the ET `today` string (`max: 2`, `ttl: 60s`) so
 * repeat reads within the TTL are served without re-querying `concerts`. The
 * builder itself stays pure and is pinned by the suite above; these pin only the
 * cache behavior.
 *
 * Build count × 2 == `db.select` call count: BS#1761 widened the builder to
 * TWO passes (headliners, then support acts), so ONE invocation now issues
 * TWO `db.select(...)` calls — and the DB mock aliases `db.select` to
 * `mockDb._chain.select`, so a warm hit (no build) still leaves the counter
 * fixed, but a cold build now advances it by 2, not 1. The cache is
 * module-scoped, so `__resetUpcomingShowsMapsCacheForTests()` runs in
 * `beforeEach` to keep a prior case's maps from leaking into the next.
 */
describe('getUpcomingShowsMapsCached (BS#1616 per-process map cache)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetUpcomingShowsMapsCacheForTests();
  });

  it('builds once on a cold miss', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([])).mockReturnValueOnce(Promise.resolve([]));
    await getUpcomingShowsMapsCached('2026-08-01');
    expect(mockDb._chain.select).toHaveBeenCalledTimes(2); // pass 1 + pass 2
  });

  it('serves a warm hit within the TTL without re-querying (identical maps reference)', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([])).mockReturnValueOnce(Promise.resolve([]));
    const first = await getUpcomingShowsMapsCached('2026-08-01');
    const second = await getUpcomingShowsMapsCached('2026-08-01');
    // Same object reference proves the second call resolved the cached promise,
    // not a fresh build.
    expect(second).toBe(first);
    expect(mockDb._chain.select).toHaveBeenCalledTimes(2);
  });

  it('rebuilds after __resetUpcomingShowsMapsCacheForTests clears the cache', async () => {
    mockDb._chain.orderBy
      .mockReturnValueOnce(Promise.resolve([]))
      .mockReturnValueOnce(Promise.resolve([]))
      .mockReturnValueOnce(Promise.resolve([]))
      .mockReturnValueOnce(Promise.resolve([]));
    await getUpcomingShowsMapsCached('2026-08-01');
    __resetUpcomingShowsMapsCacheForTests();
    await getUpcomingShowsMapsCached('2026-08-01');
    expect(mockDb._chain.select).toHaveBeenCalledTimes(4); // 2 builds × 2 passes
  });

  it('rebuilds for a distinct today key (date roll → miss)', async () => {
    mockDb._chain.orderBy
      .mockReturnValueOnce(Promise.resolve([]))
      .mockReturnValueOnce(Promise.resolve([]))
      .mockReturnValueOnce(Promise.resolve([]))
      .mockReturnValueOnce(Promise.resolve([]));
    await getUpcomingShowsMapsCached('2026-08-01');
    await getUpcomingShowsMapsCached('2026-08-02'); // a different ET calendar day
    expect(mockDb._chain.select).toHaveBeenCalledTimes(4); // 2 builds × 2 passes
  });

  it('coalesces two concurrent cold calls into a single build', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([])).mockReturnValueOnce(Promise.resolve([]));
    const [a, b] = await Promise.all([
      getUpcomingShowsMapsCached('2026-08-01'),
      getUpcomingShowsMapsCached('2026-08-01'),
    ]);
    // Both callers awaited the same in-flight promise → same resolved object.
    expect(a).toBe(b);
    expect(mockDb._chain.select).toHaveBeenCalledTimes(2); // one build's pass 1 + pass 2
  });

  it('does not cache a rejected build — the next call retries', async () => {
    // Pass 1 rejects, so the build never reaches pass 2's query (sequential
    // awaits) — only ONE queued value is consumed by the failed attempt.
    mockDb._chain.orderBy
      .mockReturnValueOnce(Promise.reject(new Error('boom')))
      .mockReturnValueOnce(Promise.resolve([]))
      .mockReturnValueOnce(Promise.resolve([]));
    await expect(getUpcomingShowsMapsCached('2026-08-01')).rejects.toThrow('boom');
    // The failed promise was evicted, so this is a fresh cold miss (not a cached
    // error): the builder runs again — pass 1 then pass 2 — and resolves.
    await expect(getUpcomingShowsMapsCached('2026-08-01')).resolves.toEqual({
      byArtistId: new Map(),
      byNormName: new Map(),
    });
    expect(mockDb._chain.select).toHaveBeenCalledTimes(3); // failed pass 1 + successful pass 1 + pass 2
  });
});
