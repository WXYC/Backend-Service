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
 * `wxyc-shared/api.yaml` v1.17.0 (event_url added in 1.17.0 / BS#1609). The published `@wxyc/shared` at this
 * worktree's pin (`^1.15.0`) does not yet export a `Concert` DTO, so we
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
  // BS#1626 / wxyc-shared#222: the `SimilarArtist` schema (`{ artist_id, weight }`)
  // as an optional + nullable array, same discipline as `genres`.
  similar_artists?: { artist_id: number; weight: number }[] | null;
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
  // Resolved + enriched headliner: the LEFT JOIN to `artist_similar_artists`
  // produced an affinity-neighbor array (BS#1626).
  similar_artists: [
    { artist_id: 5121, weight: 4.83 },
    { artist_id: 88, weight: 2.1 },
  ],
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
  // the projection yields NULL genres and NULL similar_artists.
  genres: null,
  similar_artists: null,
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
        'similar_artists',
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
    // Parity pin: the by-id projection carries the BS#1624 genres join, so a
    // by-id read can never lag the list's enrichment fields.
    expect(Object.keys(projection)).toContain('genres');
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
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([resolvedRow, unresolvedCleanRow]));
    const { byArtistId } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.size).toBe(1); // the unresolved row is not in the id map
    expect(byArtistId.get(4211)).toEqual(toConcertDTO(resolvedRow));
  });

  it('keys a resolved row in byNormName off the CANONICAL name, not the raw', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([resolvedRow]));
    const { byNormName } = await getUpcomingShowsMaps('2026-08-01');
    // canonical 'Nilüfer Yanya' → 'nilüfer yanya'; the diacritic-free raw
    // 'Nilufer Yanya' → 'nilufer yanya' is NOT the key.
    expect(byNormName.get('nilüfer yanya')).toEqual(toConcertDTO(resolvedRow));
    expect(byNormName.has('nilufer yanya')).toBe(false);
  });

  it('keys an unresolved clean row in byNormName off the raw name', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([unresolvedCleanRow]));
    const { byArtistId, byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.size).toBe(0); // unresolved → absent from the id map
    expect(byNormName.get('wishy')).toEqual(toConcertDTO(unresolvedCleanRow));
  });

  it('keys a billing-string raw off its ENTIRE normalized string (inert key)', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([billingRow]));
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
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([messy]));
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
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([soon, later]));
    const { byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byNormName.get('wishy')).toEqual(toConcertDTO(soon));
  });

  it('collapses multiple dates for one artist id to the SOONEST (first row wins)', async () => {
    const soon: UpcomingRow = { ...resolvedRow, id: 500, starts_on: '2026-08-10' };
    const later: UpcomingRow = { ...resolvedRow, id: 501, starts_on: '2026-09-10' };
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([soon, later]));
    const { byArtistId } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.get(4211)).toEqual(toConcertDTO(soon));
  });

  it('LEFT JOINs artists so a resolved row can source its canonical name', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([]));
    await getUpcomingShowsMaps('2026-08-01');
    // The join to artists must be a LEFT join — an INNER join would silently
    // drop every unresolved concert (headlining_artist_id IS NULL), which is
    // exactly the set the name arm exists to recover.
    expect(mockDb._chain.leftJoin).toHaveBeenCalled();
  });

  it('never selects internal ingestion columns', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([]));
    await getUpcomingShowsMaps('2026-08-01');
    const projection = mockDb._chain.select.mock.calls[0][0] as Record<string, string>;
    const selectedColumns = Object.values(projection);
    for (const internal of INTERNAL_COLUMNS) {
      expect(selectedColumns).not.toContain(internal);
    }
  });

  it('returns two empty maps for an empty upcoming set', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([]));
    const { byArtistId, byNormName } = await getUpcomingShowsMaps('2026-08-01');
    expect(byArtistId.size).toBe(0);
    expect(byNormName.size).toBe(0);
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
 * Build count == `db.select` call count: the builder issues exactly one
 * `db.select(...)` per invocation, and the DB mock aliases `db.select` to
 * `mockDb._chain.select`, so a warm hit (no build) leaves the counter fixed. The
 * cache is module-scoped, so `__resetUpcomingShowsMapsCacheForTests()` runs in
 * `beforeEach` to keep a prior case's maps from leaking into the next.
 */
describe('getUpcomingShowsMapsCached (BS#1616 per-process map cache)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetUpcomingShowsMapsCacheForTests();
  });

  it('builds once on a cold miss', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([]));
    await getUpcomingShowsMapsCached('2026-08-01');
    expect(mockDb._chain.select).toHaveBeenCalledTimes(1);
  });

  it('serves a warm hit within the TTL without re-querying (identical maps reference)', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([]));
    const first = await getUpcomingShowsMapsCached('2026-08-01');
    const second = await getUpcomingShowsMapsCached('2026-08-01');
    // Same object reference proves the second call resolved the cached promise,
    // not a fresh build.
    expect(second).toBe(first);
    expect(mockDb._chain.select).toHaveBeenCalledTimes(1);
  });

  it('rebuilds after __resetUpcomingShowsMapsCacheForTests clears the cache', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([])).mockReturnValueOnce(Promise.resolve([]));
    await getUpcomingShowsMapsCached('2026-08-01');
    __resetUpcomingShowsMapsCacheForTests();
    await getUpcomingShowsMapsCached('2026-08-01');
    expect(mockDb._chain.select).toHaveBeenCalledTimes(2);
  });

  it('rebuilds for a distinct today key (date roll → miss)', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([])).mockReturnValueOnce(Promise.resolve([]));
    await getUpcomingShowsMapsCached('2026-08-01');
    await getUpcomingShowsMapsCached('2026-08-02'); // a different ET calendar day
    expect(mockDb._chain.select).toHaveBeenCalledTimes(2);
  });

  it('coalesces two concurrent cold calls into a single build', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([]));
    const [a, b] = await Promise.all([
      getUpcomingShowsMapsCached('2026-08-01'),
      getUpcomingShowsMapsCached('2026-08-01'),
    ]);
    // Both callers awaited the same in-flight promise → same resolved object.
    expect(a).toBe(b);
    expect(mockDb._chain.select).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejected build — the next call retries', async () => {
    mockDb._chain.orderBy
      .mockReturnValueOnce(Promise.reject(new Error('boom')))
      .mockReturnValueOnce(Promise.resolve([]));
    await expect(getUpcomingShowsMapsCached('2026-08-01')).rejects.toThrow('boom');
    // The failed promise was evicted, so this is a fresh cold miss (not a cached
    // error): the builder runs again and resolves.
    await expect(getUpcomingShowsMapsCached('2026-08-01')).resolves.toEqual({
      byArtistId: new Map(),
      byNormName: new Map(),
    });
    expect(mockDb._chain.select).toHaveBeenCalledTimes(2);
  });
});
