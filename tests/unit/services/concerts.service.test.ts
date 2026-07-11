/**
 * Unit tests for the concerts read service (BS#1603).
 *
 * `@wxyc/database` resolves to tests/mocks/database.mock.ts, so these pin
 * the pieces that don't need PostgreSQL:
 *   - `toConcertDTO` — nested venue embedding, numeric→number price
 *     conversion, null passthrough, and (the leak barrier) the exact wire
 *     key set: no internal ingestion columns.
 *   - The select projection never references the internal columns, so they
 *     can't reach the response regardless of the mapper.
 *
 * Windowing behavior (date-only rows, curated predicate, pagination against
 * real SQL) is covered by tests/integration/concerts.spec.js.
 */
import { db } from '@wxyc/database';
import {
  ConcertDTO,
  ConcertJoinRow,
  getConcertsCount,
  getConcertsPage,
  getUpcomingShowsForArtists,
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

describe('getUpcomingShowsForArtists (BS#1607)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('short-circuits an empty artist-id list without touching the DB', async () => {
    const result = await getUpcomingShowsForArtists([], '2026-08-01');
    expect(result.size).toBe(0);
    expect(mockDb._chain.selectDistinctOn).not.toHaveBeenCalled();
  });

  it('maps each row to a ConcertDTO keyed by headlining_artist_id', async () => {
    const other: ConcertJoinRow = { ...timedRow, id: 202, headlining_artist_id: 5555 };
    // Terminal .orderBy() resolves the DISTINCT ON row set for this call.
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([timedRow, other]));

    const result = await getUpcomingShowsForArtists([4211, 5555], '2026-08-01');

    expect(result.size).toBe(2);
    expect(result.get(4211)).toEqual(toConcertDTO(timedRow));
    expect(result.get(5555)).toEqual(toConcertDTO(other));
  });

  it('distinct-selects on headlining_artist_id (soonest-per-artist collapse)', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([]));
    await getUpcomingShowsForArtists([4211], '2026-08-01');
    // The DISTINCT ON expression list must lead with headlining_artist_id.
    const distinctArgs = mockDb._chain.selectDistinctOn.mock.calls[0][0] as string[];
    expect(distinctArgs).toEqual(['headlining_artist_id']);
  });

  it('never selects internal ingestion columns', async () => {
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([]));
    await getUpcomingShowsForArtists([4211], '2026-08-01');
    const projection = mockDb._chain.selectDistinctOn.mock.calls[0][1] as Record<string, string>;
    const selectedColumns = Object.values(projection);
    for (const internal of INTERNAL_COLUMNS) {
      expect(selectedColumns).not.toContain(internal);
    }
  });

  it('skips a defensive null headlining_artist_id row (never a Map key)', async () => {
    const nulledKey: ConcertJoinRow = { ...timedRow, headlining_artist_id: null };
    mockDb._chain.orderBy.mockReturnValueOnce(Promise.resolve([nulledKey]));
    const result = await getUpcomingShowsForArtists([4211], '2026-08-01');
    expect(result.size).toBe(0);
  });
});
