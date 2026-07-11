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
  ConcertJoinRow,
  getConcertsCount,
  getConcertsPage,
  toConcertDTO,
} from '../../../apps/backend/services/concerts.service';

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
  ticket_url: 'https://catscradle.com/event/nilufer-yanya/',
  image_url: 'https://catscradle.com/img/nilufer-yanya.jpg',
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
  price_min: null,
  price_max: null,
  age_restriction: null,
  venue_address: null,
};

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
