/**
 * Shared fixtures for the triangle-shows-etl unit suites. ONE copy of the
 * source-shaped builders and the seed snapshot — jest runs transpile-only,
 * so a wire-type change only propagates reliably when there is a single
 * builder to update (three drifting copies would each keep their suite
 * green against a stale world-model).
 */
import type { TsEvent, TsHealth, TsVenue } from '../../../../jobs/triangle-shows-etl/types';

/** The 21-venue triangle-shows seed as of 2026-07-10
 *  (WXYC/triangle-shows backend/app/seed.py) — the 5 excluded slugs plus
 *  16 ingested. Update HERE (only) when the source seed changes. */
export const ALL_SOURCE_SLUGS = [
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
] as const;

export const makeTsVenue = (slug: string, overrides: Partial<TsVenue> = {}): TsVenue => ({
  id: 1,
  name: slug,
  slug,
  city: 'Durham',
  ...overrides,
});

export const makeTsEvent = (overrides: Partial<TsEvent> = {}): TsEvent => ({
  id: 101,
  venue_id: 3,
  name: 'Jessica Pratt',
  artist: 'Jessica Pratt',
  support_artists: null,
  date: '2026-08-14',
  doors_time: null,
  show_time: null,
  ticket_url: 'https://example.com/tickets/101',
  price_min: 18,
  price_max: 22,
  image_url: 'https://example.com/101.jpg',
  source_url: 'https://thepinhook.com/event/101/',
  genre: 'folk',
  subgenre: null,
  status: 'on_sale',
  age_restriction: null,
  description: null,
  source: 'venuepilot',
  source_key: 'ext:12345',
  removed_at: null,
  venue_name: 'The Pinhook',
  venue_slug: 'the-pinhook',
  venue_city: 'Durham',
  ...overrides,
});

export const makeTsHealth = (overrides: Partial<TsHealth> = {}): TsHealth => ({
  status: 'healthy',
  event_count: 100,
  venue_count: 21,
  last_scrape: '2026-07-09T22:00:00+00:00',
  version: 'abc123',
  ...overrides,
});
