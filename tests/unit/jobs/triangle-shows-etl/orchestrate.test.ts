/**
 * Unit tests for the triangle-shows-etl orchestrator. All dependencies
 * (health / venues / events fetches, venue resolution, upsert) are
 * injected fakes — no network, no DB.
 */
import { runEtl, type RunOptions } from '../../../../jobs/triangle-shows-etl/orchestrate';
import { EXCLUDED_VENUE_SLUGS } from '../../../../jobs/triangle-shows-etl/venues';
import type { TsEvent, TsHealth, TsVenue } from '../../../../jobs/triangle-shows-etl/types';

// The real 21-slug seed (see venues.test.ts): 5 excluded + 16 ingested.
const ALL_SOURCE_SLUGS = [
  'koka-booth',
  'red-hat',
  'dpac',
  'the-ritz',
  'lincoln-theatre',
  'cats-cradle',
  'motorco',
  'local-506',
  'the-pinhook',
  'kings',
  'cats-cradle-back-room',
  'the-cave',
  'haw-river-ballroom',
  'neptunes-parlour',
  'shadowbox-studio',
  'rubies',
  'stancyks',
  'boom-club',
  'chapel-of-bones',
  'pour-house',
  'slims',
];

const venue = (slug: string, id: number): TsVenue => ({
  id,
  name: slug,
  slug,
  city: 'Durham',
  capacity: null,
  size_category: 'small',
  website: null,
  color: '#000000',
});

const sourceVenues = ALL_SOURCE_SLUGS.map((slug, i) => venue(slug, i + 1));

const event = (id: number, venueSlug: string, overrides: Partial<TsEvent> = {}): TsEvent => ({
  id,
  venue_id: 1,
  name: `Event ${id}`,
  artist: 'Jessica Pratt',
  support_artists: null,
  date: '2026-08-14',
  doors_time: null,
  show_time: '20:00:00',
  ticket_url: null,
  price_min: null,
  price_max: null,
  image_url: null,
  genre: null,
  subgenre: null,
  status: 'on_sale',
  age_restriction: null,
  description: null,
  source: 'venuepilot',
  source_key: `ext:${id}`,
  updated_at: null,
  removed_at: null,
  venue_name: venueSlug,
  venue_slug: venueSlug,
  venue_city: 'Durham',
  venue_color: '#000000',
  ...overrides,
});

const freshHealth: TsHealth = {
  status: 'healthy',
  event_count: 100,
  venue_count: 21,
  // ~7h before the injected `now` — normal for the 05:05 UTC pull.
  last_scrape: '2026-07-09T22:00:00+00:00',
  version: 'abc123',
};

const NOW = new Date('2026-07-10T05:05:00Z');

const makeOpts = (
  overrides: Partial<RunOptions> = {}
): RunOptions & {
  upserts: Array<{ source_id: string; venueId: number }>;
  provisioned: string[];
} => {
  const upserts: Array<{ source_id: string; venueId: number }> = [];
  const provisioned: string[] = [];
  let nextVenueId = 100;
  const opts: RunOptions & { upserts: typeof upserts; provisioned: typeof provisioned } = {
    fetchHealth: () => Promise.resolve(freshHealth),
    fetchVenues: () => Promise.resolve(sourceVenues),
    fetchEvents: () => Promise.resolve<TsEvent[]>([]),
    resolveVenueId: (slug) => {
      provisioned.push(slug);
      nextVenueId += 1;
      return Promise.resolve(nextVenueId);
    },
    upsertConcert: (mapped, venueId) => {
      upserts.push({ source_id: mapped.concert.source_id, venueId });
      return Promise.resolve({ concert_id: upserts.length, inserted: true });
    },
    now: () => NOW,
    upserts,
    provisioned,
    ...overrides,
  };
  return opts;
};

describe('runEtl — venue provisioning and partition', () => {
  it('provisions exactly the 16 ingested venues; excluded slugs never get a row', async () => {
    const opts = makeOpts();
    const totals = await runEtl(opts);

    expect(totals.venues_seen).toBe(21);
    expect(totals.venues_ingested).toBe(16);
    expect(opts.provisioned).toHaveLength(16);
    for (const excluded of EXCLUDED_VENUE_SLUGS) {
      expect(opts.provisioned).not.toContain(excluded);
    }
  });

  it('fails the run when an excluded slug vanishes from the source venue list', async () => {
    const opts = makeOpts({
      fetchVenues: () => Promise.resolve(sourceVenues.filter((v) => v.slug !== 'haw-river-ballroom')),
    });
    await expect(runEtl(opts)).rejects.toThrow(/haw-river-ballroom/);
  });
});

describe('runEtl — event flow', () => {
  it('skips events at excluded venues and upserts the rest', async () => {
    const opts = makeOpts({
      fetchEvents: () =>
        Promise.resolve([
          event(1, 'the-pinhook'),
          event(2, 'cats-cradle'), // excluded — RHP's venue
          event(3, 'kings'),
          event(4, 'motorco'), // excluded
        ]),
    });
    const totals = await runEtl(opts);

    expect(totals.events_seen).toBe(4);
    expect(totals.events_excluded).toBe(2);
    expect(totals.upserts_total).toBe(2);
    expect(opts.upserts.map((u) => u.source_id)).toEqual(['the-pinhook:ext:1', 'kings:ext:3']);
  });

  it('counts map errors without wedging the run (one bad event, rest proceed)', async () => {
    const opts = makeOpts({
      fetchEvents: () =>
        Promise.resolve([
          event(1, 'the-pinhook', { status: 'postponed' }), // unknown status -> map error
          event(2, 'kings'),
        ]),
    });
    const totals = await runEtl(opts);

    expect(totals.map_errors).toBe(1);
    expect(totals.upserts_total).toBe(1);
  });

  it('counts tombstoned upserts', async () => {
    const opts = makeOpts({
      fetchEvents: () =>
        Promise.resolve([event(1, 'the-pinhook', { removed_at: '2026-07-08T10:00:00+00:00' }), event(2, 'kings')]),
    });
    const totals = await runEtl(opts);

    expect(totals.tombstones_seen).toBe(1);
    expect(totals.upserts_total).toBe(2);
  });

  it('provisions an unknown event venue on demand instead of dropping its events', async () => {
    const opts = makeOpts({
      fetchEvents: () => Promise.resolve([event(1, 'brand-new-room', { venue_name: 'Brand New Room' })]),
    });
    const totals = await runEtl(opts);

    expect(totals.upserts_total).toBe(1);
    expect(opts.provisioned).toContain('brand-new-room');
  });

  it('counts upsert errors per event without aborting the loop', async () => {
    let calls = 0;
    const opts = makeOpts({
      fetchEvents: () => Promise.resolve([event(1, 'the-pinhook'), event(2, 'kings')]),
      upsertConcert: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('boom'));
        return Promise.resolve({ concert_id: 1, inserted: true });
      },
    });
    const totals = await runEtl(opts);

    expect(totals.upsert_errors).toBe(1);
    expect(totals.upserts_total).toBe(1);
  });
});

describe('runEtl — source staleness', () => {
  it('flags a last_scrape older than 24h', async () => {
    const opts = makeOpts({
      fetchHealth: () => Promise.resolve({ ...freshHealth, last_scrape: '2026-07-08T22:00:00+00:00' }),
    });
    const totals = await runEtl(opts);
    expect(totals.source_stale).toBe(true);
  });

  it('flags an absent last_scrape', async () => {
    const opts = makeOpts({
      fetchHealth: () => Promise.resolve({ ...freshHealth, last_scrape: null }),
    });
    const totals = await runEtl(opts);
    expect(totals.source_stale).toBe(true);
  });

  it('does not flag ~7h-old data (normal at the 05:05 UTC pull; source scrapes 06:00/18:00 ET)', async () => {
    const totals = await runEtl(makeOpts());
    expect(totals.source_stale).toBe(false);
  });

  it('treats a health-probe failure as stale but continues the run', async () => {
    const opts = makeOpts({
      fetchHealth: () => Promise.reject(new Error('connect ECONNREFUSED')),
      fetchEvents: () => Promise.resolve([event(1, 'the-pinhook')]),
    });
    const totals = await runEtl(opts);
    expect(totals.source_stale).toBe(true);
    expect(totals.upserts_total).toBe(1);
  });
});

describe('runEtl — back-dated start', () => {
  it('pulls with start = NY calendar date minus 8 days (tombstone-visibility contract)', async () => {
    let seenStart: string | null = null;
    const opts = makeOpts({
      fetchEvents: (start) => {
        seenStart = start;
        return Promise.resolve<TsEvent[]>([]);
      },
    });
    await runEtl(opts);
    // NOW is 05:05Z on Jul 10 == Jul 10 01:05 EDT; 8 days back is Jul 2.
    expect(seenStart).toBe('2026-07-02');
  });
});
