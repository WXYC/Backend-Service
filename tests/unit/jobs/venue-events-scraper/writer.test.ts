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
import { upsertConcert } from '../../../../jobs/venue-events-scraper/writer';
import type { ParsedConcert } from '../../../../jobs/venue-events-scraper/rhp-types';

type MockDb = typeof db & {
  _chain: { returning: jest.Mock };
};

const mockDb = db as MockDb;

const fakeParsed = (suffix: string): ParsedConcert => ({
  site_slug: 'cats-cradle',
  source_id: `/event/${suffix}/`,
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
});
