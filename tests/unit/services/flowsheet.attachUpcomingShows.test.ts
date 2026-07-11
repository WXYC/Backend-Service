/**
 * Unit tests for the per-playcut upcoming-show enrichment (BS#1607,
 * touring-events Phase 3).
 *
 * `@wxyc/database` resolves to tests/mocks/database.mock.ts, so these pin the
 * pure batching + projection logic without PostgreSQL:
 *   - `attachUpcomingShows` collects the DISTINCT resolved artist ids across a
 *     feed page and does exactly ONE `getUpcomingShowsForArtists` call (the
 *     no-N+1 guarantee), then fans the soonest concert back onto each match;
 *   - `transformToV2` emits `upcoming_show` only when present, so a no-match
 *     track row is byte-identical to its pre-1607 shape (parity requirement).
 *
 * The end-to-end SQL windowing (curated predicate, soonest-wins DISTINCT ON,
 * removed/past exclusion, bounded query count for an N-row page) is covered by
 * tests/integration/flowsheet-upcoming-show.spec.js.
 */
import { attachUpcomingShows, transformToV2 } from '../../../apps/backend/services/flowsheet.service';
import * as concertsService from '../../../apps/backend/services/concerts.service';
import { IFSEntry, IFSEntryMetadata } from '../../../apps/backend/controllers/flowsheet.controller';
import type { ConcertDTO } from '../../../apps/backend/services/concerts.service';

const nullMetadata: IFSEntryMetadata = {
  artwork_url: null,
  discogs_url: null,
  release_year: null,
  spotify_url: null,
  apple_music_url: null,
  youtube_music_url: null,
  bandcamp_url: null,
  soundcloud_url: null,
  artist_bio: null,
  artist_wikipedia_url: null,
  genres: null,
  styles: null,
};

const createTrackEntry = (overrides: Partial<IFSEntry> = {}): IFSEntry => ({
  id: 1,
  show_id: 100,
  album_id: 501,
  rotation_id: null,
  entry_type: 'track',
  track_title: 'la paradoja',
  track_position: null,
  album_title: 'DOGA',
  artist_name: 'Juana Molina',
  record_label: 'Sonamos',
  label_id: null,
  play_order: 1,
  request_flag: false,
  segue: false,
  message: null,
  add_time: new Date('2026-04-17T22:53:48.500Z'),
  dj_name: null,
  rotation_bin: null,
  on_streaming: null,
  legacy_entry_id: null,
  legacy_release_id: null,
  linkage_source: null,
  linkage_confidence: null,
  linked_at: null,
  metadata_status: 'pending',
  enriching_since: null,
  radio_hour: null,
  metadata: nullMetadata,
  artist_id: 4211,
  ...overrides,
});

const makeConcert = (overrides: Partial<ConcertDTO> = {}): ConcertDTO => ({
  id: 900,
  venue: {
    id: 3,
    slug: 'cats-cradle',
    name: "Cat's Cradle",
    city: 'Carrboro',
    state: 'NC',
    address: '300 E Main St, Carrboro, NC 27510',
  },
  starts_on: '2026-08-14',
  starts_at: '2026-08-15T00:00:00.000Z',
  doors_at: '2026-08-14T23:00:00.000Z',
  headlining_artist_raw: 'Juana Molina',
  headlining_artist_id: 4211,
  title: null,
  supporting_artists_raw: [],
  ticket_url: 'https://catscradle.com/event/juana-molina/',
  image_url: 'https://catscradle.com/img/juana-molina.jpg',
  price_min: 25,
  price_max: 28.5,
  age_restriction: 'All Ages',
  status: 'on_sale',
  ...overrides,
});

describe('attachUpcomingShows (BS#1607)', () => {
  let lookup: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();
    lookup = jest.spyOn(concertsService, 'getUpcomingShowsForArtists');
  });

  it('skips the DB entirely when the page has no resolved track artists', async () => {
    const entries = [
      createTrackEntry({ id: 1, artist_id: null }),
      createTrackEntry({ id: 2, entry_type: 'show_start', artist_id: 4211 }),
    ];
    await attachUpcomingShows(entries);
    expect(lookup).not.toHaveBeenCalled();
    expect(entries[0].upcoming_show).toBeUndefined();
  });

  it('does exactly ONE lookup for an N-row page, with DISTINCT artist ids', async () => {
    lookup.mockResolvedValueOnce(new Map());
    const entries = [
      createTrackEntry({ id: 1, artist_id: 4211 }),
      createTrackEntry({ id: 2, artist_id: 4211 }), // duplicate artist
      createTrackEntry({ id: 3, artist_id: 7000 }),
      createTrackEntry({ id: 4, artist_id: null }), // free-form, no artist
      createTrackEntry({ id: 5, entry_type: 'talkset', artist_id: 9999 }), // non-track
    ];
    await attachUpcomingShows(entries);

    expect(lookup).toHaveBeenCalledTimes(1);
    const [artistIds] = lookup.mock.calls[0];
    expect([...(artistIds as number[])].sort((a, b) => a - b)).toEqual([4211, 7000]);
  });

  it('attaches the matched concert to every track row of that artist', async () => {
    const concert = makeConcert({ headlining_artist_id: 4211 });
    lookup.mockResolvedValueOnce(new Map([[4211, concert]]));
    const entries = [
      createTrackEntry({ id: 1, artist_id: 4211 }),
      createTrackEntry({ id: 2, artist_id: 4211 }),
      createTrackEntry({ id: 3, artist_id: 7000 }), // no match in the map
    ];
    await attachUpcomingShows(entries);

    expect(entries[0].upcoming_show).toBe(concert);
    expect(entries[1].upcoming_show).toBe(concert);
    expect(entries[2].upcoming_show).toBeUndefined();
  });

  it('leaves every row untouched when no artist has an upcoming date', async () => {
    lookup.mockResolvedValueOnce(new Map());
    const entries = [createTrackEntry({ id: 1, artist_id: 4211 })];
    await attachUpcomingShows(entries);
    expect(entries[0].upcoming_show).toBeUndefined();
  });
});

describe('transformToV2 upcoming_show projection (BS#1607)', () => {
  it('emits upcoming_show on a track row when the enrichment matched', () => {
    const concert = makeConcert();
    const entry = createTrackEntry({ upcoming_show: concert });
    const result = transformToV2(entry);
    expect(result.upcoming_show).toBe(concert);
  });

  it('omits the key entirely on a no-match track row (parity with pre-1607)', () => {
    const entry = createTrackEntry(); // upcoming_show undefined
    const result = transformToV2(entry);
    expect(result).not.toHaveProperty('upcoming_show');
  });

  it('omits the key on a null upcoming_show (defensive)', () => {
    const entry = createTrackEntry({ upcoming_show: null });
    const result = transformToV2(entry);
    expect(result).not.toHaveProperty('upcoming_show');
  });

  it('never emits upcoming_show on a non-track (marker) row', () => {
    const concert = makeConcert();
    const entry = createTrackEntry({
      entry_type: 'show_start',
      upcoming_show: concert,
    });
    const result = transformToV2(entry);
    expect(result).not.toHaveProperty('upcoming_show');
  });
});
