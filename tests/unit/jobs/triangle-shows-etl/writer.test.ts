/**
 * Unit tests for the triangle-shows-etl DB writer (BS#1589).
 *
 * `db` is mocked via `tests/mocks/database.mock.ts` (Jest module mapper),
 * same harness as the venue-events-scraper writer tests. The invariants
 * pinned here are the ones that differ from (or mirror) the RHP writer:
 *
 *   - `status` IS in the ON CONFLICT set — for source='triangle_shows'
 *     status is source-authoritative, refreshed in both directions on
 *     every upsert. Deliberate divergence from rhp_scrape's insert-only /
 *     admin-managed status.
 *   - `removed_at` is in both paths and nullable — set on tombstone,
 *     cleared on reappearance.
 *   - `first_scraped_at` is omitted from both paths (BS#1385, same
 *     invariant as the RHP writer).
 */
import { db } from '@wxyc/database';
import { ensureVenue, upsertConcert } from '../../../../jobs/triangle-shows-etl/writer';
import type { MappedConcert } from '../../../../jobs/triangle-shows-etl/map';

type MockDb = typeof db & {
  _chain: {
    returning: jest.Mock;
    limit: jest.Mock;
    onConflictDoUpdate: jest.Mock;
    values: jest.Mock;
  };
};

const mockDb = db as MockDb;

const fakeMapped = (overrides: Partial<MappedConcert> = {}): MappedConcert => ({
  source_id: 'rubies:ext:12345',
  starts_on: '2026-11-06',
  starts_at: new Date('2026-11-07T01:00:00Z'),
  doors_at: null,
  headlining_artist_raw: 'Jessica Pratt',
  title: 'Jessica Pratt',
  supporting_artists_raw: [],
  status: 'on_sale',
  price_min: '15.00',
  price_max: null,
  age_restriction: null,
  ticket_url: null,
  image_url: null,
  removed_at: null,
  raw: { id: 1 } as MappedConcert['raw'],
  ...overrides,
});

const insertRows = (): Record<string, unknown>[] =>
  mockDb._chain.values.mock.calls
    .flatMap((c: unknown[]) => (Array.isArray(c[0]) ? c[0] : [c[0]]))
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && 'source_id' in r);

const setClauses = (): Record<string, unknown>[] =>
  mockDb._chain.onConflictDoUpdate.mock.calls
    .map((c: unknown[]) => (c[0] as { set?: Record<string, unknown> } | undefined)?.set)
    .filter((set): set is Record<string, unknown> => !!set && 'venue_id' in set);

describe('upsertConcert', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('threads the DB outcome through (inserted true/false from xmax)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42, inserted: true }]);
    expect(await upsertConcert(fakeMapped(), 7, new Date('2026-07-10T05:05:00Z'))).toEqual({
      concert_id: 42,
      inserted: true,
    });

    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42, inserted: false }]);
    expect(await upsertConcert(fakeMapped(), 7, new Date('2026-07-10T05:05:00Z'))).toEqual({
      concert_id: 42,
      inserted: false,
    });
  });

  it("writes source='triangle_shows' with the venue-qualified source_id", async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertConcert(fakeMapped(), 7, new Date('2026-07-10T05:05:00Z'));
    expect(insertRows()[0]).toMatchObject({ source: 'triangle_shows', source_id: 'rubies:ext:12345' });
  });

  it('refreshes status in the ON CONFLICT set — source-authoritative, unlike rhp_scrape', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: false }]);
    await upsertConcert(fakeMapped({ status: 'sold_out' }), 7, new Date('2026-07-10T05:05:00Z'));
    expect(insertRows()[0]).toHaveProperty('status', 'sold_out');
    expect(setClauses()[0]).toHaveProperty('status', 'sold_out');
  });

  it('conditionally clears headlining_artist_id in the ON CONFLICT set when the raw headliner changed — the write-once resolver never revisits a non-NULL FK, so a headliner swap on a rename-stable source_key would otherwise serve the wrong artist forever', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: false }]);
    await upsertConcert(fakeMapped(), 7, new Date('2026-07-10T05:05:00Z'));

    const set = setClauses()[0];
    expect(set).toHaveProperty('headlining_artist_id');
    // The value is a drizzle SQL fragment (CASE WHEN ... IS DISTINCT FROM
    // excluded... THEN NULL ELSE ... END) — pin the mechanism keywords so a
    // refactor to an unconditional NULL (which would strip resolved ids
    // from every untouched row each night) fails this test.
    const fragmentText = JSON.stringify(
      (set.headlining_artist_id as { queryChunks?: unknown[] })?.queryChunks ?? set.headlining_artist_id
    );
    expect(fragmentText).toMatch(/IS DISTINCT FROM/i);
    expect(fragmentText).toMatch(/excluded/i);
  });

  it('mirrors removed_at in both paths: a Date on tombstone, null on reappearance (the null must be IN the set to clear the column)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: false }]);
    const tombstone = new Date('2026-07-01T05:00:00Z');
    await upsertConcert(fakeMapped({ removed_at: tombstone }), 7, new Date('2026-07-10T05:05:00Z'));
    expect(insertRows()[0]).toHaveProperty('removed_at', tombstone);
    expect(setClauses()[0]).toHaveProperty('removed_at', tombstone);

    jest.clearAllMocks();
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: false }]);
    await upsertConcert(fakeMapped({ removed_at: null }), 7, new Date('2026-07-10T05:05:00Z'));
    expect(insertRows()[0]).toHaveProperty('removed_at', null);
    expect(setClauses()[0]).toHaveProperty('removed_at', null);
  });

  it('writes nullable starts_at and NOT NULL starts_on (date-only events)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertConcert(fakeMapped({ starts_at: null }), 7, new Date('2026-07-10T05:05:00Z'));
    expect(insertRows()[0]).toHaveProperty('starts_at', null);
    expect(insertRows()[0]).toHaveProperty('starts_on', '2026-11-06');
    expect(setClauses()[0]).toHaveProperty('starts_at', null);
    expect(setClauses()[0]).toHaveProperty('starts_on', '2026-11-06');
  });

  it('omits first_scraped_at from both the INSERT values and the ON CONFLICT set (BS#1385 stability anchor) while refreshing scraped_at', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: false }]);
    await upsertConcert(fakeMapped(), 7, new Date('2026-07-10T05:05:00Z'));

    expect(insertRows().length).toBeGreaterThan(0);
    expect(insertRows()[0]).toHaveProperty('scraped_at');
    for (const row of insertRows()) {
      expect(row).not.toHaveProperty('first_scraped_at');
    }

    expect(setClauses().length).toBeGreaterThan(0);
    expect(setClauses()[0]).toHaveProperty('scraped_at');
    for (const set of setClauses()) {
      expect(set).not.toHaveProperty('first_scraped_at');
    }
  });
});

describe('ensureVenue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb._chain.limit.mockResolvedValue([]);
  });

  it("inserts a new venue with source name/city and state='NC'", async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 3, created: true }]);
    const result = await ensureVenue('the-pinhook', 'The Pinhook', 'Durham');
    expect(result).toEqual({ venue_id: 3, created: true });
    const venueRows = mockDb._chain.values.mock.calls
      .flatMap((c: unknown[]) => (Array.isArray(c[0]) ? c[0] : [c[0]]))
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && 'slug' in r);
    expect(venueRows[0]).toMatchObject({ slug: 'the-pinhook', name: 'The Pinhook', city: 'Durham', state: 'NC' });
  });

  it('resolves the existing id when the setWhere predicate suppressed a no-op UPDATE', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);
    mockDb._chain.limit.mockResolvedValueOnce([{ id: 5 }]);
    const result = await ensureVenue('the-pinhook', 'The Pinhook', 'Durham');
    expect(result).toEqual({ venue_id: 5, created: false });
  });

  it('throws when the venue row vanished mid-upsert instead of returning a bogus id', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);
    mockDb._chain.limit.mockResolvedValueOnce([]);
    await expect(ensureVenue('the-pinhook', 'The Pinhook', 'Durham')).rejects.toThrow(/the-pinhook/);
  });
});
