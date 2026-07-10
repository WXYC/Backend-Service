/**
 * Unit tests for the triangle-shows-etl orchestrator (BS#1589).
 *
 * Dependencies (venue resolution, concert upsert) are injected so the
 * loop runs without network or DB — same DI pattern as the
 * venue-events-scraper orchestrator. Pins: full-venue provisioning
 * (16 venues even when eventless), exclusion-list skips (zero rows for
 * excluded slugs), per-event error isolation, and the counter totals.
 */
import { runEtl, type Totals } from '../../../../jobs/triangle-shows-etl/orchestrate';
import type { TriangleShowsEvent, TriangleShowsVenue } from '../../../../jobs/triangle-shows-etl/map';

const venue = (id: number, slug: string): TriangleShowsVenue => ({
  id,
  name: slug,
  slug,
  city: 'Durham',
  size_category: 'small',
  color: '#000000',
});

// A minimal source set: the 5 excluded slugs (they must exist or the
// partition assertion throws) plus 3 ingested ones.
const VENUES: TriangleShowsVenue[] = [
  venue(1, 'cats-cradle'),
  venue(2, 'cats-cradle-back-room'),
  venue(3, 'local-506'),
  venue(4, 'motorco'),
  venue(5, 'haw-river-ballroom'),
  venue(6, 'the-pinhook'),
  venue(7, 'rubies'),
  venue(8, 'stancyks'),
];

const event = (id: number, venue_id: number, overrides: Partial<TriangleShowsEvent> = {}): TriangleShowsEvent => ({
  id,
  venue_id,
  name: `Event ${id}`,
  artist: null,
  support_artists: null,
  date: '2026-11-06',
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
  venue_name: null,
  venue_slug: null,
  venue_city: null,
  venue_color: null,
  ...overrides,
});

const makeDeps = () => {
  const provisioned: string[] = [];
  const upserts: Array<{ source_id: string; venueId: number }> = [];
  const resolveVenueId = jest.fn((slug: string) => {
    provisioned.push(slug);
    const sourceVenue = VENUES.find((v) => v.slug === slug);
    if (!sourceVenue) throw new Error(`fixture bug: unknown slug ${slug}`);
    return Promise.resolve({ venue_id: 100 + sourceVenue.id, created: false });
  });
  const upsertConcert = jest.fn((mapped: { source_id: string }, venueId: number) => {
    upserts.push({ source_id: mapped.source_id, venueId });
    return Promise.resolve({ concert_id: upserts.length, inserted: true });
  });
  return { provisioned, upserts, resolveVenueId, upsertConcert };
};

describe('runEtl', () => {
  it('provisions every ingested venue even when it has no events, and never provisions an excluded slug', async () => {
    const deps = makeDeps();
    await runEtl({ venues: VENUES, events: [], ...deps });

    expect(deps.provisioned.sort()).toEqual(['rubies', 'stancyks', 'the-pinhook']);
  });

  it('upserts events for ingested venues and skips events at excluded venues without upserting', async () => {
    const deps = makeDeps();
    const totals: Totals = await runEtl({
      venues: VENUES,
      events: [
        event(1, 6), // the-pinhook: ingested
        event(2, 1), // cats-cradle: excluded
        event(3, 7), // rubies: ingested
      ],
      ...deps,
    });

    expect(deps.upserts.map((u) => u.source_id).sort()).toEqual(['rubies:ext:3', 'the-pinhook:ext:1']);
    expect(totals.events_seen).toBe(3);
    expect(totals.events_excluded).toBe(1);
    expect(totals.upserts_total).toBe(2);
    expect(totals.upserts_inserted).toBe(2);
  });

  it('keys the upsert by the venue slug resolved from venue_id — the API-side denormalized venue_slug is not trusted', async () => {
    const deps = makeDeps();
    await runEtl({
      venues: VENUES,
      events: [event(9, 7, { venue_slug: 'wrong-slug-from-api' })],
      ...deps,
    });
    expect(deps.upserts[0].source_id).toBe('rubies:ext:9');
  });

  it('counts an unknown venue_id as an error without wedging the run', async () => {
    const deps = makeDeps();
    const totals = await runEtl({
      venues: VENUES,
      events: [event(1, 999), event(2, 6)],
      ...deps,
    });
    expect(totals.unknown_venue_errors).toBe(1);
    expect(totals.upserts_total).toBe(1);
  });

  it('isolates a mapping failure to the one event (map_errors) and continues', async () => {
    const deps = makeDeps();
    const totals = await runEtl({
      venues: VENUES,
      events: [event(1, 6, { status: 'not-a-status' }), event(2, 6)],
      ...deps,
    });
    expect(totals.map_errors).toBe(1);
    expect(totals.upserts_total).toBe(1);
  });

  it('isolates an upsert failure to the one event (upsert_errors) and continues', async () => {
    const deps = makeDeps();
    deps.upsertConcert.mockRejectedValueOnce(new Error('boom'));
    const totals = await runEtl({
      venues: VENUES,
      events: [event(1, 6), event(2, 7)],
      ...deps,
    });
    expect(totals.upsert_errors).toBe(1);
    expect(totals.upserts_total).toBe(1);
  });

  it('counts venue rows created this run — steady state is 0; nonzero flags a new room or an ingested-slug rename (which permanently re-keys that venue) for audit', async () => {
    const deps = makeDeps();
    deps.resolveVenueId
      .mockResolvedValueOnce({ venue_id: 106, created: true })
      .mockResolvedValueOnce({ venue_id: 107, created: false })
      .mockResolvedValueOnce({ venue_id: 108, created: true });
    const totals = await runEtl({ venues: VENUES, events: [], ...deps });
    expect(totals.venues_created).toBe(2);
  });

  it('counts a starts_at earlier than doors_at as a time-order anomaly without modifying the row — the source can pair a past-midnight show_time with the advertised date, and no heuristic can safely re-shift it', async () => {
    const deps = makeDeps();
    const totals = await runEtl({
      venues: VENUES,
      // doors 23:00, show 00:30 on the SAME advertised date: starts_at
      // composes ~22.5h before doors.
      events: [event(1, 6, { doors_time: '23:00:00', show_time: '00:30:00' }), event(2, 6)],
      ...deps,
    });
    expect(totals.time_order_anomalies).toBe(1);
    // Pass-through, not a drop: both events still upsert.
    expect(totals.upserts_total).toBe(2);
  });

  it('counts tombstoned events so the removed_at mirror is observable in the run summary', async () => {
    const deps = makeDeps();
    const totals = await runEtl({
      venues: VENUES,
      events: [event(1, 6, { removed_at: '2026-07-01T05:00:00+00:00' }), event(2, 6)],
      ...deps,
    });
    expect(totals.events_tombstoned).toBe(1);
  });

  it('propagates the partition assertion (excluded slug missing at the source) as a run-fatal error', async () => {
    const deps = makeDeps();
    const drifted = VENUES.filter((v) => v.slug !== 'motorco');
    await expect(runEtl({ venues: drifted, events: [], ...deps })).rejects.toThrow(/motorco/);
  });

  it('fails the run when venue provisioning throws (a broken venues table must not silently drop a whole venue)', async () => {
    const deps = makeDeps();
    deps.resolveVenueId.mockRejectedValueOnce(new Error('db down'));
    await expect(runEtl({ venues: VENUES, events: [], ...deps })).rejects.toThrow(/db down/);
  });
});
