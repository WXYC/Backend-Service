/**
 * Unit tests for the triangle-shows ETL writer. `db` is mocked via
 * `tests/mocks/database.mock.ts` (Jest module mapper); we inspect the
 * chain's `values` / `onConflictDoUpdate` invocations to pin the
 * writer-discipline invariants this job carries:
 *
 *  1. `status` and `removed_at` refresh in BOTH directions on every
 *     upsert (source-authoritative — deliberate divergence from
 *     `rhp_scrape`'s insert-only/admin-managed status; the source
 *     maintains an explicit per-event status enum, so for these rows it
 *     is strictly better-informed than a BS admin).
 *  2. `first_scraped_at` stays INSERT-only (omitted from values AND the
 *     ON CONFLICT set), matching the RHP writer's BS#1385 anchor.
 *  3. Venue upserts pass a `setWhere` no-op-skip predicate so
 *     `last_modified` stays an honest audit signal, and width guards
 *     live at the ensureVenue chokepoint.
 */
import { db } from '@wxyc/database';
import { ensureVenue, makeVenueCache, upsertConcert } from '../../../../jobs/triangle-shows-etl/writer';
import { mapEvent } from '../../../../jobs/triangle-shows-etl/map';
import { makeTsEvent } from './fixtures';

type MockDb = typeof db & {
  _chain: {
    returning: jest.Mock;
    limit: jest.Mock;
    onConflictDoUpdate: jest.Mock;
    values: jest.Mock;
  };
};

const mockDb = db as MockDb;

const scrapedAt = new Date('2026-07-10T05:05:00Z');

const concertValuesRows = (): Record<string, unknown>[] =>
  mockDb._chain.values.mock.calls
    .flatMap((c: unknown[]) => (Array.isArray(c[0]) ? c[0] : [c[0]]))
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && 'source_id' in r && 'venue_id' in r);

const concertSetClauses = (): Record<string, unknown>[] =>
  mockDb._chain.onConflictDoUpdate.mock.calls
    .map((c: unknown[]) => (c[0] as { set?: Record<string, unknown> } | undefined)?.set)
    .filter((set): set is Record<string, unknown> => !!set && 'venue_id' in set);

const venueValuesRows = (): Record<string, unknown>[] =>
  mockDb._chain.values.mock.calls
    .flatMap((c: unknown[]) => (Array.isArray(c[0]) ? c[0] : [c[0]]))
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && 'slug' in r);

const fakeEvent = (overrides: Parameters<typeof makeTsEvent>[0] = {}) =>
  makeTsEvent({
    id: 7,
    name: 'Juana Molina',
    artist: 'Juana Molina',
    date: '2026-09-01',
    doors_time: '19:00:00',
    show_time: '20:00:00',
    price_min: 20,
    price_max: null,
    genre: null,
    ticket_url: null,
    image_url: null,
    source_key: 'ext:777',
    ...overrides,
  });

describe('upsertConcert', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns inserted=true when xmax = 0 (fresh INSERT)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 11, inserted: true }]);
    const result = await upsertConcert(mapEvent(fakeEvent()), 5, scrapedAt);
    expect(result).toEqual({ concert_id: 11, inserted: true });
  });

  it('returns inserted=false when xmax != 0 (ON CONFLICT UPDATE)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 11, inserted: false }]);
    const result = await upsertConcert(mapEvent(fakeEvent()), 5, scrapedAt);
    expect(result).toEqual({ concert_id: 11, inserted: false });
  });

  it('refreshes status in the ON CONFLICT set (source-authoritative, both directions)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: false }]);
    await upsertConcert(mapEvent(fakeEvent({ status: 'sold_out' })), 5, scrapedAt);

    const sets = concertSetClauses();
    expect(sets.length).toBeGreaterThan(0);
    // Presence in `set` is the invariant: a sold_out -> on_sale downgrade
    // must propagate exactly like the upgrade did.
    expect(sets[0]).toHaveProperty('status', 'sold_out');
  });

  describe('removed_at lifecycle (both directions)', () => {
    it('sets removed_at on a tombstoned event in values AND the ON CONFLICT set', async () => {
      mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: false }]);
      const tombstoned = mapEvent(fakeEvent({ removed_at: '2026-07-08T10:00:00+00:00' }));
      await upsertConcert(tombstoned, 5, scrapedAt);

      expect(concertValuesRows()[0]).toHaveProperty('removed_at', new Date('2026-07-08T10:00:00Z'));
      expect(concertSetClauses()[0]).toHaveProperty('removed_at', new Date('2026-07-08T10:00:00Z'));
    });

    it('CLEARS removed_at back to NULL when a delisted event reappears', async () => {
      // The behavioral inversion from rhp_scrape's insert-only policy: a
      // fresh non-tombstoned payload upserting onto a row whose
      // removed_at was set must null it out. Requiring the property to
      // be present with value null (not merely absent) is what pins
      // "cleared", since an absent key would leave the old tombstone.
      mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: false }]);
      const reappeared = mapEvent(fakeEvent({ removed_at: null }));
      await upsertConcert(reappeared, 5, scrapedAt);

      const set = concertSetClauses()[0];
      expect(Object.prototype.hasOwnProperty.call(set, 'removed_at')).toBe(true);
      expect(set.removed_at).toBeNull();
    });
  });

  it('omits first_scraped_at from both values and the ON CONFLICT set (INSERT-only anchor, matching the RHP writer)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertConcert(mapEvent(fakeEvent()), 5, scrapedAt);

    const rows = concertValuesRows();
    const sets = concertSetClauses();
    expect(rows.length).toBeGreaterThan(0);
    expect(sets.length).toBeGreaterThan(0);
    // scraped_at anchors: still spelled on both sides (the per-run sweep
    // stamp first_scraped_at exists to contrast with).
    expect(rows[0]).toHaveProperty('scraped_at');
    expect(sets[0]).toHaveProperty('scraped_at');
    for (const row of rows) expect(row).not.toHaveProperty('first_scraped_at');
    for (const set of sets) expect(set).not.toHaveProperty('first_scraped_at');
  });

  it('conditionally clears headlining_artist_id in the ON CONFLICT set when the raw headliner changed — the resolver is write-once (claims WHERE headlining_artist_id IS NULL), so a headliner swap on a rename-stable ext:/url: source_key would otherwise serve the old artist forever', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: false }]);
    await upsertConcert(mapEvent(fakeEvent()), 5, scrapedAt);

    const set = concertSetClauses()[0];
    expect(set).toHaveProperty('headlining_artist_id');
    // A drizzle SQL fragment: pin the CASE/IS DISTINCT FROM/excluded
    // mechanism so a refactor to an unconditional NULL (which would strip
    // every resolved id nightly) fails here.
    // Robust to both SQL-object shapes: real drizzle exposes queryChunks
    // (string chunks interleaved with column refs); the unit-mock env's
    // tag exposes the template strings via `.sql` (String() joins them).
    const frag = set.headlining_artist_id as {
      sql?: string | readonly string[];
      queryChunks?: Array<{ value?: unknown }>;
    };
    const fragmentText =
      frag?.sql != null
        ? [frag.sql].flat().join(' ')
        : (frag?.queryChunks ?? []).flatMap((c) => (Array.isArray(c.value) ? (c.value as string[]) : [])).join(' ');
    expect(fragmentText).toMatch(/IS DISTINCT FROM/i);
    expect(fragmentText).toMatch(/excluded/i);
  });

  it('writes event_url in both the INSERT values and the ON CONFLICT set (source-authoritative venue page, BS#1609)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: false }]);
    const url = 'https://thepinhook.com/event/777/';
    await upsertConcert(mapEvent(fakeEvent({ source_url: url })), 5, scrapedAt);

    const rows = concertValuesRows();
    const sets = concertSetClauses();
    expect(rows.length).toBeGreaterThan(0);
    expect(sets.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('event_url', url);
    // In `set` too, so a moved venue-page URL propagates on re-scrape.
    expect(sets[0]).toHaveProperty('event_url', url);
  });

  it('threads venue_id and the venue-qualified source_id into the row', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1, inserted: true }]);
    await upsertConcert(mapEvent(fakeEvent()), 31337, scrapedAt);

    const row = concertValuesRows()[0];
    expect(row).toHaveProperty('venue_id', 31337);
    expect(row).toHaveProperty('source_id', 'the-pinhook:ext:777');
    expect(row).toHaveProperty('source', 'triangle_shows');
  });
});

describe('ensureVenue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb._chain.limit.mockResolvedValue([]);
  });

  it('returns created=true when the DB reports xmax=0 (fresh INSERT)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 3, created: true }]);
    const result = await ensureVenue('the-pinhook', 'The Pinhook', 'Durham');
    expect(result).toEqual({ venue_id: 3, created: true });
  });

  it('hardcodes state NC and refreshes name/city from the source in the set clause', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 3, created: true }]);
    await ensureVenue('the-pinhook', 'The Pinhook', 'Durham');

    expect(venueValuesRows()[0]).toMatchObject({
      slug: 'the-pinhook',
      name: 'The Pinhook',
      city: 'Durham',
      state: 'NC',
    });

    const venueSets = mockDb._chain.onConflictDoUpdate.mock.calls
      .map((c: unknown[]) => (c[0] as { set?: Record<string, unknown> } | undefined)?.set)
      .filter((set): set is Record<string, unknown> => !!set && 'city' in set && !('venue_id' in set));
    expect(venueSets[0]).toMatchObject({ name: 'The Pinhook', city: 'Durham' });
  });

  it('passes a setWhere no-op-skip predicate (the honest-last_modified invariant)', async () => {
    // The mock chains through any config, so pin the CONFIG SHAPE: without
    // this, a refactor that drops setWhere keeps every suite green while
    // every nightly run bumps venues.last_modified on all 16 rows and the
    // fallback-SELECT branch becomes dead code pinning an unreachable state.
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 3, created: true }]);
    await ensureVenue('the-pinhook', 'The Pinhook', 'Durham');

    const venueConfig = mockDb._chain.onConflictDoUpdate.mock.calls
      .map((c: unknown[]) => c[0] as { set?: Record<string, unknown>; setWhere?: unknown } | undefined)
      .find((cfg) => !!cfg?.set && 'city' in cfg.set);
    expect(venueConfig).toBeDefined();
    expect(venueConfig?.setWhere).toBeDefined();
  });

  it('falls back to SELECT when the setWhere predicate suppressed a no-op UPDATE', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);
    mockDb._chain.limit.mockResolvedValueOnce([{ id: 3 }]);
    const result = await ensureVenue('the-pinhook', 'The Pinhook', 'Durham');
    expect(result).toEqual({ venue_id: 3, created: false });
  });

  it('throws when the row vanished between upsert and fallback SELECT', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([]);
    mockDb._chain.limit.mockResolvedValueOnce([]);
    await expect(ensureVenue('the-pinhook', 'The Pinhook', 'Durham')).rejects.toThrow(/the-pinhook/);
  });

  describe('width guards at the chokepoint (covers on-demand provisioning too)', () => {
    it('throws on a slug over varchar(64) — a key is never truncated', async () => {
      await expect(ensureVenue('x'.repeat(65), 'Name', 'Durham')).rejects.toThrow(/64/);
      expect(mockDb._chain.values).not.toHaveBeenCalled();
    });

    it('clamps a name over varchar(128) instead of failing the venue (source allows String(200))', async () => {
      // PG errors rather than truncates, and one long-named venue must not
      // drop its whole calendar from the mirror nightly.
      mockDb._chain.returning.mockResolvedValueOnce([{ id: 3, created: true }]);
      await ensureVenue('the-pinhook', 'P'.repeat(200), 'Durham');

      expect((venueValuesRows()[0].name as string).length).toBe(128);
    });
  });
});

describe('makeVenueCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb._chain.limit.mockResolvedValue([]);
  });

  it('resolves each slug once per run and reports created=false on cache hits', async () => {
    mockDb._chain.returning.mockResolvedValue([{ id: 8, created: true }]);
    const cache = makeVenueCache();

    const first = await cache.get('kings', 'Kings', 'Raleigh');
    const second = await cache.get('kings', 'Kings', 'Raleigh');

    expect(first).toEqual({ venue_id: 8, created: true });
    // The cache hit must NOT re-report created — the orchestrator counts
    // created outcomes as the partition-drift signal.
    expect(second).toEqual({ venue_id: 8, created: false });
    expect(cache.size()).toBe(1);
    // One upsert only — second get() served from cache.
    expect(mockDb._chain.returning).toHaveBeenCalledTimes(1);
  });
});
