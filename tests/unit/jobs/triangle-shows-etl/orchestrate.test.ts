/**
 * Unit tests for the triangle-shows-etl orchestrator. All dependencies
 * (health / venues / events fetches, venue resolution, upsert) are
 * injected fakes — no network, no DB. The run guards live here (not in
 * job.ts) precisely so these tests can exercise them.
 */
import { runEtl, type RunOptions } from '../../../../jobs/triangle-shows-etl/orchestrate';
import { EXCLUDED_VENUE_SLUGS } from '../../../../jobs/triangle-shows-etl/venues';
import type { TsEvent } from '../../../../jobs/triangle-shows-etl/types';
import { ALL_SOURCE_SLUGS, makeTsEvent, makeTsHealth, makeTsVenue } from './fixtures';

const sourceVenues = ALL_SOURCE_SLUGS.map((slug, i) => makeTsVenue(slug, { id: i + 1 }));

const event = (id: number, venueSlug: string, overrides: Partial<TsEvent> = {}): TsEvent =>
  makeTsEvent({
    id,
    name: `Event ${id}`,
    artist: 'Jessica Pratt',
    show_time: '20:00:00',
    price_min: null,
    price_max: null,
    ticket_url: null,
    image_url: null,
    genre: null,
    source_key: `ext:${id}`,
    venue_name: venueSlug,
    venue_slug: venueSlug,
    ...overrides,
  });

// ~7h after the fixture's last_scrape — normal for the 05:05 UTC pull.
const NOW = new Date('2026-07-10T05:05:00Z');

const makeOpts = (
  overrides: Partial<RunOptions> = {}
): RunOptions & {
  upserts: Array<{ source_id: string; venueId: number }>;
  provisioned: string[];
} => {
  const upserts: Array<{ source_id: string; venueId: number }> = [];
  const provisioned: string[] = [];
  const venueIdBySlug = new Map<string, number>();
  let nextVenueId = 100;
  const opts: RunOptions & { upserts: typeof upserts; provisioned: typeof provisioned } = {
    fetchHealth: () => Promise.resolve(makeTsHealth()),
    fetchVenues: () => Promise.resolve(sourceVenues),
    fetchEvents: () => Promise.resolve<TsEvent[]>([]),
    // Memoized like the real makeVenueCache: created=true only on the
    // first resolution of a slug.
    resolveVenueId: (slug) => {
      const hit = venueIdBySlug.get(slug);
      if (hit !== undefined) return Promise.resolve({ venue_id: hit, created: false });
      provisioned.push(slug);
      nextVenueId += 1;
      venueIdBySlug.set(slug, nextVenueId);
      return Promise.resolve({ venue_id: nextVenueId, created: true });
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

// Most tests need at least one successfully upserted event so the run
// guards (empty snapshot / zero upserts / majority failure) don't fire.
const someEvents = [event(1, 'the-pinhook'), event(2, 'kings')];

describe('runEtl — venue provisioning and partition', () => {
  it('provisions exactly the 16 ingested venues; excluded slugs never get a row', async () => {
    const opts = makeOpts({ fetchEvents: () => Promise.resolve(someEvents) });
    const totals = await runEtl(opts);

    expect(totals.venues_seen).toBe(21);
    expect(totals.venues_ingested).toBe(16);
    expect(totals.venues_created).toBe(16); // first run — every row is new
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
          event(3, 'slims'),
        ]),
    });
    const totals = await runEtl(opts);

    expect(totals.map_errors).toBe(1);
    expect(totals.upserts_total).toBe(2);
  });

  it('classifies a null-venue_slug event at an EXCLUDED venue as excluded via venue_id, not as a map error', async () => {
    // A source glitch that nulls the denormalized venue_slug must not turn
    // RHP-partition events (which this job would skip anyway) into
    // map_errors that inflate the failure guard and misdirect triage.
    const catsCradleId = sourceVenues[ALL_SOURCE_SLUGS.indexOf('cats-cradle')].id;
    const opts = makeOpts({
      fetchEvents: () =>
        Promise.resolve([event(1, 'cats-cradle', { venue_slug: null, venue_id: catsCradleId }), event(2, 'kings')]),
    });
    const totals = await runEtl(opts);

    expect(totals.events_excluded).toBe(1);
    expect(totals.map_errors).toBe(0);
    expect(totals.upserts_total).toBe(1);
  });

  it('counts a starts_at earlier than doors_at as a time-order anomaly and still upserts the row unmodified', async () => {
    // Free-text source scrapers can pair a past-midnight show_time with
    // the advertised date ('Sat Oct 31, doors 11PM, show 12:30AM' stores
    // date=…-10-31 + show_time=00:30) — starts_at composes ~22.5h before
    // doors_at. No heuristic can safely re-shift either side (the inverse
    // skew also occurs), so this is observability only.
    const opts = makeOpts({
      fetchEvents: () =>
        Promise.resolve([
          event(1, 'the-pinhook', { doors_time: '23:00:00', show_time: '00:30:00', date: '2026-10-31' }),
          event(2, 'kings'),
        ]),
    });
    const totals = await runEtl(opts);

    expect(totals.time_order_anomalies).toBe(1);
    expect(totals.upserts_total).toBe(2);
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

  it('provisions an unknown event venue on demand and counts it', async () => {
    const opts = makeOpts({
      fetchEvents: () =>
        Promise.resolve([event(1, 'brand-new-room', { venue_name: 'Brand New Room' }), event(2, 'kings')]),
    });
    const totals = await runEtl(opts);

    expect(totals.upserts_total).toBe(2);
    expect(totals.venues_provisioned_on_demand).toBe(1);
    expect(totals.venues_created).toBe(17); // 16 listed + 1 on demand
    expect(opts.provisioned).toContain('brand-new-room');
  });

  it('counts upsert errors per event without aborting the loop', async () => {
    let calls = 0;
    const opts = makeOpts({
      fetchEvents: () => Promise.resolve([event(1, 'the-pinhook'), event(2, 'kings'), event(3, 'slims')]),
      upsertConcert: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('boom'));
        return Promise.resolve({ concert_id: 1, inserted: true });
      },
    });
    const totals = await runEtl(opts);

    expect(totals.upsert_errors).toBe(1);
    expect(totals.upserts_total).toBe(2);
  });

  it('negative-caches a venue whose provisioning failed: events skip without re-running the doomed resolve', async () => {
    const resolveCalls: string[] = [];
    const opts = makeOpts({
      fetchEvents: () =>
        Promise.resolve([
          event(1, 'the-cave'),
          event(2, 'the-cave'),
          event(3, 'the-cave'),
          // Enough healthy events that the majority-failure guard stays
          // quiet — this test is about the negative cache, not the guard.
          event(4, 'kings'),
          event(5, 'slims'),
          event(6, 'the-pinhook'),
          event(7, 'rubies'),
        ]),
      resolveVenueId: (slug) => {
        resolveCalls.push(slug);
        if (slug === 'the-cave') return Promise.reject(new Error('value too long for type character varying(128)'));
        return Promise.resolve({ venue_id: 42, created: false });
      },
    });
    const totals = await runEtl(opts);

    // One failing attempt in the step-2 loop, then the negative cache
    // absorbs all three of the venue's events — no per-event re-INSERT.
    expect(resolveCalls.filter((s) => s === 'the-cave')).toHaveLength(1);
    expect(totals.venue_resolve_errors).toBe(1);
    expect(totals.events_skipped_failed_venue).toBe(3);
    expect(totals.upserts_total).toBe(4);
  });
});

describe('runEtl — run guards', () => {
  it('fails the run on an empty snapshot (a live Triangle calendar is never empty)', async () => {
    const opts = makeOpts({ fetchEvents: () => Promise.resolve<TsEvent[]>([]) });
    await expect(runEtl(opts)).rejects.toThrow(/empty snapshot/);
  });

  it('fails the run when ingestable events exist but zero upserted', async () => {
    const opts = makeOpts({
      fetchEvents: () => Promise.resolve([event(1, 'the-pinhook'), event(2, 'kings')]),
      upsertConcert: () => Promise.reject(new Error('boom')),
    });
    await expect(runEtl(opts)).rejects.toThrow(/0 upserted/);
  });

  it('fails the run when failures outnumber successes (wholesale drift must not stay green)', async () => {
    const opts = makeOpts({
      fetchEvents: () =>
        Promise.resolve([
          event(1, 'the-pinhook', { status: 'postponed' }),
          event(2, 'kings', { status: 'postponed' }),
          event(3, 'the-cave', { status: 'postponed' }),
          event(4, 'slims'),
        ]),
    });
    await expect(runEtl(opts)).rejects.toThrow(/failures reached successes/);
  });

  it('fails the run at exactly 50% failures (one broken platform can be half the corpus)', async () => {
    const opts = makeOpts({
      fetchEvents: () =>
        Promise.resolve([
          event(1, 'the-pinhook', { status: 'postponed' }),
          event(2, 'kings', { status: 'postponed' }),
          event(3, 'the-cave'),
          event(4, 'slims'),
        ]),
    });
    await expect(runEtl(opts)).rejects.toThrow(/failures reached successes/);
  });

  it('passes when successes outnumber failures', async () => {
    const opts = makeOpts({
      fetchEvents: () =>
        Promise.resolve([
          event(1, 'the-pinhook', { status: 'postponed' }), // 1 failure
          event(2, 'kings'),
          event(3, 'slims'),
        ]),
    });
    const totals = await runEtl(opts);
    expect(totals.map_errors).toBe(1);
    expect(totals.upserts_total).toBe(2);
  });
});

describe('runEtl — source staleness', () => {
  it('flags a last_scrape older than 24h', async () => {
    const opts = makeOpts({
      fetchHealth: () => Promise.resolve(makeTsHealth({ last_scrape: '2026-07-08T22:00:00+00:00' })),
      fetchEvents: () => Promise.resolve(someEvents),
    });
    const totals = await runEtl(opts);
    expect(totals.source_stale).toBe(true);
  });

  it('flags an absent last_scrape', async () => {
    const opts = makeOpts({
      fetchHealth: () => Promise.resolve(makeTsHealth({ last_scrape: null })),
      fetchEvents: () => Promise.resolve(someEvents),
    });
    const totals = await runEtl(opts);
    expect(totals.source_stale).toBe(true);
  });

  it('flags an UNPARSEABLE last_scrape as stale (NaN must not classify as fresh)', async () => {
    // A serialization drift (epoch int, locale string) makes getTime()
    // NaN; every comparison with NaN is false, so without an explicit
    // finiteness check the freshness alert would permanently stop firing.
    const opts = makeOpts({
      fetchHealth: () => Promise.resolve(makeTsHealth({ last_scrape: 'yesterday at noon' })),
      fetchEvents: () => Promise.resolve(someEvents),
    });
    const totals = await runEtl(opts);
    expect(totals.source_stale).toBe(true);
  });

  it('does not flag ~7h-old data (normal at the 05:05 UTC pull; source scrapes 06:00/18:00 ET)', async () => {
    const totals = await runEtl(makeOpts({ fetchEvents: () => Promise.resolve(someEvents) }));
    expect(totals.source_stale).toBe(false);
  });

  it('treats a health-probe failure as stale but continues the run', async () => {
    const opts = makeOpts({
      fetchHealth: () => Promise.reject(new Error('connect ECONNREFUSED')),
      fetchEvents: () => Promise.resolve(someEvents),
    });
    const totals = await runEtl(opts);
    expect(totals.source_stale).toBe(true);
    expect(totals.upserts_total).toBe(2);
  });
});

describe('runEtl — back-dated start', () => {
  it('pulls with start = NY calendar date minus 8 days (tombstone-visibility contract)', async () => {
    let seenStart: string | null = null;
    const opts = makeOpts({
      fetchEvents: (start) => {
        seenStart = start;
        return Promise.resolve(someEvents);
      },
    });
    await runEtl(opts);
    // NOW is 05:05Z on Jul 10 == Jul 10 01:05 EDT; 8 days back is Jul 2.
    expect(seenStart).toBe('2026-07-02');
  });
});
