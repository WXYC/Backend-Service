/**
 * Unit tests for the per-playcut upcoming-show enrichment (BS#1607, widened to
 * a hybrid id-arm ∪ name-arm match in BS#1613, touring-events Phase 3).
 *
 * `@wxyc/database` resolves to tests/mocks/database.mock.ts, so these pin the
 * pure batching + fan-out logic without PostgreSQL:
 *   - `attachUpcomingShows` does exactly ONE `getUpcomingShowsMaps` call for a
 *     feed page (the no-N+1 guarantee), then fans the soonest concert onto each
 *     track via the id arm (album-resolved `artist_id`) with a normalized-name
 *     arm fallback (free-text plays + clean unresolved concerts, BS#1613);
 *   - `transformToV2` emits `upcoming_show` only when present, so a no-match
 *     track row is byte-identical to its pre-1607 shape (parity requirement).
 *
 * The end-to-end SQL windowing (removed/past exclusion, canonical-name key,
 * soonest-wins collapse, bounded query count for an N-row page) is covered by
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
  ticket_url: 'https://www.etix.com/ticket/p/juana-molina',
  image_url: 'https://catscradle.com/img/juana-molina.jpg',
  event_url: 'https://catscradle.com/event/juana-molina/',
  price_min: 25,
  price_max: 28.5,
  age_restriction: 'All Ages',
  status: 'on_sale',
  ...overrides,
});

/** Build the {byArtistId, byNormName} return of getUpcomingShowsMaps. */
const maps = (byArtistId: Map<number, ConcertDTO> = new Map(), byNormName: Map<string, ConcertDTO> = new Map()) => ({
  byArtistId,
  byNormName,
});

describe('attachUpcomingShows (BS#1607 id arm + BS#1613 name arm)', () => {
  let lookup: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();
    lookup = jest.spyOn(concertsService, 'getUpcomingShowsMaps');
  });

  it('skips the DB when no track row carries an artist id or a non-empty name', async () => {
    const entries = [
      createTrackEntry({ id: 1, entry_type: 'show_start', artist_id: 4211 }), // marker
      createTrackEntry({ id: 2, artist_id: null, artist_name: '   ' }), // blank free text
    ];
    await attachUpcomingShows(entries);
    expect(lookup).not.toHaveBeenCalled();
    expect(entries[1].upcoming_show).toBeUndefined();
  });

  it('does exactly ONE getUpcomingShowsMaps call for an N-row page, with a today date', async () => {
    lookup.mockResolvedValueOnce(maps());
    const entries = [
      createTrackEntry({ id: 1, artist_id: 4211 }),
      createTrackEntry({ id: 2, artist_id: 4211 }), // duplicate artist
      createTrackEntry({ id: 3, artist_id: null, artist_name: 'Wishy' }), // free-text
      createTrackEntry({ id: 4, entry_type: 'talkset', artist_id: 9999 }), // non-track
    ];
    await attachUpcomingShows(entries);

    expect(lookup).toHaveBeenCalledTimes(1);
    const [today] = lookup.mock.calls[0];
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/); // America/New_York calendar date
  });

  // --- id arm (BS#1607 regression guard) ---

  it('attaches via the id arm to every catalog track row of that artist', async () => {
    const concert = makeConcert({ headlining_artist_id: 4211 });
    lookup.mockResolvedValueOnce(maps(new Map([[4211, concert]])));
    const entries = [
      createTrackEntry({ id: 1, artist_id: 4211, artist_name: 'Juana Molina' }),
      createTrackEntry({ id: 2, artist_id: 4211, artist_name: 'Juana Molina' }),
      createTrackEntry({ id: 3, artist_id: 7000, artist_name: 'Someone Else' }), // no map entry
    ];
    await attachUpcomingShows(entries);

    expect(entries[0].upcoming_show).toBe(concert);
    expect(entries[1].upcoming_show).toBe(concert);
    expect(entries[2].upcoming_show).toBeUndefined();
  });

  // --- name arm (BS#1613) ---

  it('attaches via the name arm to a free-text play of a resolved artist', async () => {
    const concert = makeConcert({ headlining_artist_id: 4211 });
    // Free-text play: no album_id → artist_id null; matched on canonical name.
    lookup.mockResolvedValueOnce(maps(new Map(), new Map([['juana molina', concert]])));
    const entries = [createTrackEntry({ id: 1, artist_id: null, artist_name: 'Juana Molina' })];
    await attachUpcomingShows(entries);
    expect(entries[0].upcoming_show).toBe(concert);
  });

  it('attaches a clean unresolved concert to a free-text play by name (null headlining_artist_id)', async () => {
    const concert = makeConcert({ headlining_artist_id: null, headlining_artist_raw: 'Wishy' });
    lookup.mockResolvedValueOnce(maps(new Map(), new Map([['wishy', concert]])));
    const entries = [createTrackEntry({ id: 1, artist_id: null, artist_name: 'Wishy' })];
    await attachUpcomingShows(entries);
    expect(entries[0].upcoming_show).toBe(concert);
    expect(entries[0].upcoming_show?.headlining_artist_id).toBeNull();
  });

  it('does not attach a billing-string concert to a single-artist play (inert key)', async () => {
    const concert = makeConcert({
      headlining_artist_id: null,
      headlining_artist_raw: 'Circle Jerks & Municipal Waste',
    });
    // The map is keyed by the ENTIRE normalized billing string.
    lookup.mockResolvedValueOnce(maps(new Map(), new Map([['circle jerks & municipal waste', concert]])));
    const entries = [createTrackEntry({ id: 1, artist_id: null, artist_name: 'Circle Jerks' })];
    await attachUpcomingShows(entries);
    expect(entries[0].upcoming_show).toBeUndefined();
  });

  // --- precedence + guards ---

  it('prefers the id arm over the name arm when a row matches both', async () => {
    const byIdConcert = makeConcert({ id: 900, headlining_artist_id: 4211 });
    const byNameConcert = makeConcert({ id: 901, headlining_artist_id: null, headlining_artist_raw: 'Juana Molina' });
    lookup.mockResolvedValueOnce(maps(new Map([[4211, byIdConcert]]), new Map([['juana molina', byNameConcert]])));
    const entries = [createTrackEntry({ id: 1, artist_id: 4211, artist_name: 'Juana Molina' })];
    await attachUpcomingShows(entries);
    expect(entries[0].upcoming_show).toBe(byIdConcert); // id arm wins
  });

  it('never matches a whitespace-only free-text name (no empty-string key collision)', async () => {
    const stray = makeConcert();
    // A hypothetical stray '' key must never be reached by a blank name.
    lookup.mockResolvedValueOnce(maps(new Map(), new Map([['', stray]])));
    const entries = [
      createTrackEntry({ id: 1, artist_id: 4211, artist_name: 'Juana Molina' }), // matchable → DB runs
      createTrackEntry({ id: 2, artist_id: null, artist_name: '   ' }), // blank free text
    ];
    await attachUpcomingShows(entries);
    expect(entries[1].upcoming_show).toBeUndefined();
  });

  it('leaves every row untouched when both maps are empty', async () => {
    lookup.mockResolvedValueOnce(maps());
    const entries = [
      createTrackEntry({ id: 1, artist_id: 4211 }),
      createTrackEntry({ id: 2, artist_id: null, artist_name: 'Wishy' }),
    ];
    await attachUpcomingShows(entries);
    expect(entries[0].upcoming_show).toBeUndefined();
    expect(entries[1].upcoming_show).toBeUndefined();
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
