/**
 * Pins the orchestrator's Sentry-capture dedup: N same-class per-event
 * failures must produce ONE captureError per (step, message-class) per
 * run — the counters and log lines carry the volume. Separate file so
 * jest.mock of the logger module can't leak into the main orchestrate
 * suite (which relies on the real no-op logger).
 *
 * The message-class keying matters because mapEvent's throw messages
 * embed per-event ids ("event id 1523") — a naive message key would make
 * every event distinct and re-create the quota flood the dedup exists to
 * prevent (a 1,500-event status drift = 1,500 Sentry events per night).
 */
import { runEtl } from '../../../../jobs/triangle-shows-etl/orchestrate';
import { captureError } from '../../../../jobs/triangle-shows-etl/logger';
import type { TsEvent } from '../../../../jobs/triangle-shows-etl/types';
import { ALL_SOURCE_SLUGS, makeTsEvent, makeTsHealth, makeTsVenue } from './fixtures';

jest.mock('../../../../jobs/triangle-shows-etl/logger', () => ({
  log: jest.fn(),
  captureError: jest.fn(),
  captureWarning: jest.fn(),
}));

const mockedCaptureError = captureError as jest.MockedFunction<typeof captureError>;

const sourceVenues = ALL_SOURCE_SLUGS.map((slug, i) => makeTsVenue(slug, { id: i + 1 }));

const event = (id: number, venueSlug: string, overrides: Partial<TsEvent> = {}): TsEvent =>
  makeTsEvent({
    id,
    name: `Event ${id}`,
    show_time: '20:00:00',
    source_key: `ext:${id}`,
    venue_name: venueSlug,
    venue_slug: venueSlug,
    ...overrides,
  });

describe('runEtl — Sentry capture dedup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('captures ONE Sentry event for N same-class map errors (per-event ids must not defeat the dedup)', async () => {
    // 3 events, all failing with the same class of error but distinct
    // event ids embedded in the message; 4 healthy events keep the
    // majority-failure guard quiet.
    const events = [
      event(1, 'the-pinhook', { status: 'postponed' }),
      event(2, 'kings', { status: 'postponed' }),
      event(3, 'slims', { status: 'postponed' }),
      event(4, 'the-cave'),
      event(5, 'rubies'),
      event(6, 'stancyks'),
      event(7, 'boom-club'),
    ];
    const totals = await runEtl({
      fetchHealth: () => Promise.resolve(makeTsHealth()),
      fetchVenues: () => Promise.resolve(sourceVenues),
      fetchEvents: () => Promise.resolve(events),
      resolveVenueId: () => Promise.resolve({ venue_id: 1, created: false }),
      upsertConcert: () => Promise.resolve({ concert_id: 1, inserted: true }),
      now: () => new Date('2026-07-10T05:05:00Z'),
    });

    expect(totals.map_errors).toBe(3);
    const mapErrorCaptures = mockedCaptureError.mock.calls.filter(([, step]) => step === 'map_error');
    expect(mapErrorCaptures).toHaveLength(1);
  });

  it('still captures DISTINCT error classes separately', async () => {
    const events = [
      event(1, 'the-pinhook', { status: 'postponed' }), // unknown status
      event(2, 'kings', { venue_slug: null, venue_id: 999 }), // missing venue_slug (999 = not an excluded venue id)
      event(3, 'slims'),
      event(4, 'the-cave'),
      event(5, 'rubies'),
    ];
    await runEtl({
      fetchHealth: () => Promise.resolve(makeTsHealth()),
      fetchVenues: () => Promise.resolve(sourceVenues),
      fetchEvents: () => Promise.resolve(events),
      resolveVenueId: () => Promise.resolve({ venue_id: 1, created: false }),
      upsertConcert: () => Promise.resolve({ concert_id: 1, inserted: true }),
      now: () => new Date('2026-07-10T05:05:00Z'),
    });

    const mapErrorCaptures = mockedCaptureError.mock.calls.filter(([, step]) => step === 'map_error');
    expect(mapErrorCaptures).toHaveLength(2);
  });
});
