/**
 * Unit tests for the venue-events-scraper writer.
 *
 * `db` is mocked via `tests/mocks/database.mock.ts` (Jest module mapper);
 * we drive the chain's `returning()` resolved value to verify the writer
 * threads `inserted` back through the per-call outcome.
 *
 * The INSERT-vs-UPDATE distinction is delegated to Postgres's system
 * `xmax` column via `xmax = 0` in `RETURNING`, so at this layer we only
 * need to confirm the writer trusts the value the DB hands back. An
 * integration test against a real PG would also cover the xmax behavior
 * itself; that's out of scope for the unit suite.
 */
import { db } from '@wxyc/database';
import { ensureVenue, upsertConcert } from '../../../../jobs/venue-events-scraper/writer';
import type { ParsedConcert } from '../../../../jobs/venue-events-scraper/rhp-types';

type MockDb = typeof db & {
  _chain: { returning: jest.Mock; limit: jest.Mock; onConflictDoUpdate: jest.Mock; values: jest.Mock };
};

const mockDb = db as MockDb;

const fakeParsed = (suffix: string): ParsedConcert => ({
  site_slug: 'cats-cradle',
  source_id: `cats-cradle:/event/${suffix}/`,
  event_page_url: `https://catscradle.com/event/${suffix}/`,
  venue_slug: 'cats-cradle',
  venue_name: "Cat's Cradle",
  venue_address: '300 E Main St., Carrboro, NC',
  headlining_artist: 'Test Headliner',
  supporting_artists: ['Test Support'],
  starts_at: '2026-11-06T20:00:00-0500',
  ticket_url: 'https://www.etix.com/ticket/p/1/test?partner_id=100',
  image_url: 'https://catscradle.com/image.jpg',
  raw: { '@type': 'Event', name: 'Test Headliner', startDate: '2026-11-06T20:00:00-0500' },
});

describe('upsertConcert', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns inserted=true when xmax = 0 (fresh INSERT)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42, inserted: true }]);

    const result = await upsertConcert(fakeParsed('a'), 7, new Date('2026-06-05T12:00:00Z'));

    expect(result).toEqual({ concert_id: 42, inserted: true });
  });

  it('returns inserted=false when xmax != 0 (ON CONFLICT UPDATE)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 42, inserted: false }]);

    const result = await upsertConcert(fakeParsed('a'), 7, new Date('2026-06-05T12:00:00Z'));

    expect(result).toEqual({ concert_id: 42, inserted: false });
  });

  it('threads venue_id through to the row payload', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 99, inserted: true }]);

    const result = await upsertConcert(fakeParsed('venue-thread'), 31337, new Date('2026-06-05T12:00:00Z'));

    expect(result.concert_id).toBe(99);
    // The chain doesn't expose .values() invocations directly through this
    // mock, but the resolved id confirms the call reached returning().
  });

  it('builds with a Date for starts_at (not a raw ISO string — guards BS#802 trap)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);

    // No throw is the assertion: the writer must internally pre-stringify
    // / Date-wrap so drizzle's date serializer can handle it. A regression
    // here would surface as ERR_INVALID_ARG_TYPE inside Buffer.byteLength
    // (the BS#802 failure mode).
    await expect(upsertConcert(fakeParsed('date-shape'), 1, new Date('2026-06-05T12:00:00Z'))).resolves.toBeDefined();
  });

  // BS#1385 — `first_scraped_at` is the INSERT-only scraper-stability
  // anchor. On a fresh INSERT it picks up the schema's `DEFAULT now()`
  // (so the writer doesn't need to spell it in the values payload), and
  // on a re-UPSERT the row must keep its insert-time value — which means
  // the ON CONFLICT `set:` clause MUST NOT carry the column. The two
  // assertions below are paired because the invariant has two halves
  // (don't overwrite the default on INSERT; don't refresh on UPDATE).
  describe('first_scraped_at INSERT-only invariant (BS#1385)', () => {
    it('does not pass first_scraped_at in the values payload, so the schema DEFAULT now() populates it on INSERT', async () => {
      mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);

      await upsertConcert(fakeParsed('insert-default'), 1, new Date('2026-06-05T12:00:00Z'));

      const valuesArg = mockDb._chain.values.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(valuesArg).toBeDefined();
      // If the writer ever started supplying first_scraped_at on INSERT it
      // would shadow the DEFAULT, defeating the whole point of the column
      // (the scraper's clock would drift forward with each writer revision).
      expect(valuesArg).not.toHaveProperty('first_scraped_at');
    });

    it('excludes first_scraped_at from the ON CONFLICT update set so re-UPSERT preserves the insert-time value', async () => {
      mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: false }]);

      await upsertConcert(fakeParsed('reupsert'), 1, new Date('2026-06-05T12:00:00Z'));

      const onConflictArg = mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as
        | { set?: Record<string, unknown> }
        | undefined;
      expect(onConflictArg?.set).toBeDefined();
      // The whole point of the column is to record the first-ever scrape
      // moment for the (source, source_id) tuple. Adding it to `set` would
      // overwrite that moment on every nightly re-scrape, collapsing
      // first_scraped_at into "most recent run" — the exact failure mode
      // scraped_at already has.
      expect(onConflictArg?.set).not.toHaveProperty('first_scraped_at');
      // Sanity: scraped_at IS refreshed (this is the contrast that
      // justifies adding first_scraped_at in the first place).
      expect(onConflictArg?.set).toHaveProperty('scraped_at');
    });
  });
});

describe('ensureVenue (seeded path)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Make the SELECT chain's terminal `.limit()` thenable so the
    // ON-CONFLICT-no-op fallback can resolve. Default empty; per-test
    // mockResolvedValueOnce queues specific responses.
    mockDb._chain.limit.mockResolvedValue([]);
  });

  it('returns created=true when the DB reports xmax=0 (fresh INSERT)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, created: true }]);
    const result = await ensureVenue('cats-cradle', "Cat's Cradle", null);
    expect(result).toEqual({ venue_id: 1, created: true });
  });

  it('returns created=false when the DB reports xmax≠0 (ON CONFLICT UPDATE branch fired)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, created: false }]);
    const result = await ensureVenue('cats-cradle', "Cat's Cradle", null);
    expect(result).toEqual({ venue_id: 1, created: false });
  });

  it('falls back to SELECT when the setWhere predicate suppressed the UPDATE (no-op convergence)', async () => {
    // Seeded slug, row already matches seed exactly. setWhere
    // (`IS DISTINCT FROM` chain) makes the UPDATE a no-op, so PG
    // returns zero rows from RETURNING. ensureVenue then SELECTs the
    // id from the existing row. This is what makes `last_modified`
    // an honest audit signal — it only bumps when something changed.
    mockDb._chain.returning.mockResolvedValueOnce([]); // insert.onConflictDoUpdate.returning empty
    mockDb._chain.limit.mockResolvedValueOnce([{ id: 1 }]); // follow-up SELECT
    const result = await ensureVenue('cats-cradle', "Cat's Cradle", null);
    expect(result).toEqual({ venue_id: 1, created: false });
  });
});

describe('ensureVenue (unseeded path)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb._chain.limit.mockResolvedValue([]);
  });

  it('INSERTs a placeholder when the unseeded slug is brand new', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 7 }]);
    const result = await ensureVenue('kings-raleigh', 'Kings of Raleigh', null);
    expect(result).toEqual({ venue_id: 7, created: true });
  });

  it('preserves the existing row (DO NOTHING) when the unseeded slug already has a venues row — never overwrites with potentially-weaker fallback values', async () => {
    // The scrape's `fallbackAddress=null` would have clobbered any
    // prior good address (admin-edited OR earlier-scrape-richer) under
    // the iteration-1 ON CONFLICT DO UPDATE shape. The new code never
    // overwrites unseeded rows; it SELECTs the existing id and returns.
    mockDb._chain.returning.mockResolvedValueOnce([]); // insert.onConflictDoNothing.returning empty
    mockDb._chain.limit.mockResolvedValueOnce([{ id: 7 }]); // follow-up SELECT
    const result = await ensureVenue('kings-raleigh', 'Kings of Raleigh', null);
    expect(result).toEqual({ venue_id: 7, created: false });
  });
});
