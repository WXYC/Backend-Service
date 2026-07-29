/**
 * Unit tests for the batched critic-review attach (album-critic-reviews
 * slice, ADR 0012; BS#1870). Modeled on
 * `tests/unit/services/flowsheet.attachUpcomingShows.test.ts`:
 *   - `attachCriticReviews` does exactly ONE `lookupCriticReviewsByAlbumIds`
 *     call for a feed page (the no-N+1 guarantee), then fans each album's
 *     reviews onto every track row carrying that `album_id` — id-arm only,
 *     no name-arm fallback (unlike `attachUpcomingShows`'s BS#1613 hybrid);
 *   - flag off (`CRITIC_REVIEWS_ENABLED` via `getConfig().enabled`) short-
 *     circuits before the DB, mirroring the `proxy.controller.test.ts`
 *     `criticReviews attach (ADR 0012)` suite's flag-mocking style;
 *   - `transformToV2` emits `critic_reviews` only when present, so a
 *     no-match or flag-off track row is byte-identical to its pre-1870 shape.
 *
 * `@wxyc/database` resolves to tests/mocks/database.mock.ts (see
 * jest.unit.config.ts), so these pin the pure batching + fan-out logic
 * without PostgreSQL. The `album-metadata-lookup.service`'s own SQL-shape
 * tests (ORDER BY, cap, wire projection) live in
 * tests/unit/services/album-metadata-lookup.service.test.ts.
 */
// Type-only: erased at compile time, so these are safe alongside the
// jest.mock(...) of runtime exports below.
import type { IFSEntry, IFSEntryMetadata } from '../../../apps/backend/controllers/flowsheet.controller';
import type { CriticReviewItem } from '@wxyc/shared/dtos';

const mockCriticReviewsConfig = jest.fn<() => { enabled: boolean }>(() => ({ enabled: false }));
jest.mock('../../../apps/backend/config/criticReviews', () => ({
  getConfig: mockCriticReviewsConfig,
}));

const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { attachCriticReviews, transformToV2 } from '../../../apps/backend/services/flowsheet.service';
import * as albumMetadataLookupService from '../../../apps/backend/services/album-metadata-lookup.service';

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

const makeReview = (overrides: Partial<CriticReviewItem> = {}): CriticReviewItem => ({
  source: 'The Quietus',
  url: 'https://thequietus.com/articles/juana-molina-doga',
  snippet: 'A record that dissolves the line between song and texture.',
  ...overrides,
});

describe('attachCriticReviews (BS#1870, id-arm only)', () => {
  let lookup: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();
    mockCriticReviewsConfig.mockReturnValue({ enabled: false });
    lookup = jest.spyOn(albumMetadataLookupService, 'lookupCriticReviewsByAlbumIds');
  });

  it('flag off: leaves every entry untouched and never touches the DB', async () => {
    mockCriticReviewsConfig.mockReturnValue({ enabled: false });
    const entries = [createTrackEntry({ id: 1, album_id: 501 })];
    const result = await attachCriticReviews(entries);
    expect(result).toBe(entries);
    expect(lookup).not.toHaveBeenCalled();
    expect(entries[0].critic_reviews).toBeUndefined();
  });

  it('flag on, no linked track rows (all album_id null or non-track): skips the DB', async () => {
    mockCriticReviewsConfig.mockReturnValue({ enabled: true });
    const entries = [
      createTrackEntry({ id: 1, entry_type: 'show_start', album_id: 501 }), // marker
      createTrackEntry({ id: 2, album_id: null }), // free-text track, no linked album
    ];
    await attachCriticReviews(entries);
    expect(lookup).not.toHaveBeenCalled();
    expect(entries[1].critic_reviews).toBeUndefined();
  });

  it('flag on: does exactly ONE lookupCriticReviewsByAlbumIds call for an N-row page, deduped by album_id', async () => {
    lookup.mockResolvedValueOnce(new Map());
    mockCriticReviewsConfig.mockReturnValue({ enabled: true });
    const entries = [
      createTrackEntry({ id: 1, album_id: 501 }),
      createTrackEntry({ id: 2, album_id: 501 }), // duplicate album_id
      createTrackEntry({ id: 3, album_id: 777 }),
      createTrackEntry({ id: 4, album_id: null }), // no linked album
      createTrackEntry({ id: 5, entry_type: 'talkset', album_id: 999 }), // non-track
    ];
    await attachCriticReviews(entries);

    expect(lookup).toHaveBeenCalledTimes(1);
    const [albumIds] = lookup.mock.calls[0];
    expect(new Set(albumIds)).toEqual(new Set([501, 777]));
  });

  it('attaches reviews only to entries whose album_id matches, absent elsewhere', async () => {
    mockCriticReviewsConfig.mockReturnValue({ enabled: true });
    const review = makeReview();
    lookup.mockResolvedValueOnce(new Map([[501, [review]]]));
    const entries = [
      createTrackEntry({ id: 1, album_id: 501 }),
      createTrackEntry({ id: 2, album_id: 501 }), // same album, also matches
      createTrackEntry({ id: 3, album_id: 777 }), // no reviews for this album
      createTrackEntry({ id: 4, album_id: null }), // free-text, no album
    ];
    await attachCriticReviews(entries);

    expect(entries[0].critic_reviews).toEqual([review]);
    expect(entries[1].critic_reviews).toEqual([review]);
    expect(entries[2].critic_reviews).toBeUndefined();
    expect(entries[3].critic_reviews).toBeUndefined();
  });

  it('never attaches by artist name — only album_id is consulted (id-arm only, no name-arm)', async () => {
    // Even though this free-text track shares the artist name of a
    // reviewed album, it carries no album_id (unlinked play) and must not
    // pick up the review via any fuzzy name match.
    mockCriticReviewsConfig.mockReturnValue({ enabled: true });
    lookup.mockResolvedValueOnce(new Map([[501, [makeReview()]]]));
    const entries = [createTrackEntry({ id: 1, album_id: null, artist_name: 'Juana Molina', album_title: 'DOGA' })];
    await attachCriticReviews(entries);
    expect(lookup).not.toHaveBeenCalled(); // no linked track row at all
    expect(entries[0].critic_reviews).toBeUndefined();
  });

  it('leaves an entry untouched when the lookup returns an empty array for its album', async () => {
    mockCriticReviewsConfig.mockReturnValue({ enabled: true });
    lookup.mockResolvedValueOnce(new Map([[501, []]]));
    const entries = [createTrackEntry({ id: 1, album_id: 501 })];
    await attachCriticReviews(entries);
    expect(entries[0].critic_reviews).toBeUndefined();
  });

  it('leaves an entry untouched when its album_id is absent from the returned map', async () => {
    mockCriticReviewsConfig.mockReturnValue({ enabled: true });
    lookup.mockResolvedValueOnce(new Map());
    const entries = [createTrackEntry({ id: 1, album_id: 501 })];
    await attachCriticReviews(entries);
    expect(entries[0].critic_reviews).toBeUndefined();
  });

  // Sentry BACKEND-SERVICE-2T / BS#1864: mirrors attachUpcomingShows's
  // defensive guard against a transient nullish array element.
  it('tolerates a nullish array element positioned after a real linked track', async () => {
    mockCriticReviewsConfig.mockReturnValue({ enabled: true });
    const review = makeReview();
    lookup.mockResolvedValueOnce(new Map([[501, [review]]]));
    const validEntry = createTrackEntry({ id: 1, album_id: 501 });
    const entries = [validEntry, undefined] as IFSEntry[];

    await expect(attachCriticReviews(entries)).resolves.toBe(entries);

    expect(validEntry.critic_reviews).toEqual([review]);
    expect(entries[1]).toBeUndefined();
  });

  it('skips the DB when the only entries are a nullish element and a non-matchable marker', async () => {
    mockCriticReviewsConfig.mockReturnValue({ enabled: true });
    const entries = [undefined, createTrackEntry({ id: 2, entry_type: 'show_start' })] as IFSEntry[];
    await expect(attachCriticReviews(entries)).resolves.toBe(entries);
    expect(lookup).not.toHaveBeenCalled();
  });

  // BS#1872 review-bounce: attachCriticReviews is Promise.all'd with
  // attachUpcomingShows at all 5 GET /flowsheet call sites, and
  // CRITIC_REVIEWS_ENABLED is already true in prod, so a rejection here
  // must not propagate — that would 500 the hottest public endpoint on a
  // mere album_critic_reviews DB blip. Mirrors proxy.controller.ts's
  // "strictly additive, must never break the response" contract for the
  // same lookup on the metadata-proxy serve path.
  it('degrades to no cards and reports to Sentry when the batched lookup rejects, instead of rejecting itself', async () => {
    mockCriticReviewsConfig.mockReturnValue({ enabled: true });
    const dbError = new Error('connection terminated unexpectedly');
    lookup.mockRejectedValueOnce(dbError);
    const entries = [createTrackEntry({ id: 1, album_id: 501 })];

    await expect(attachCriticReviews(entries)).resolves.toBe(entries);

    expect(entries[0].critic_reviews).toBeUndefined();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0][0]).toBe(dbError);
  });
});

describe('transformToV2 critic_reviews projection (BS#1870)', () => {
  it('emits critic_reviews on a track row when the attach matched', () => {
    const reviews = [makeReview()];
    const entry = createTrackEntry({ critic_reviews: reviews });
    const result = transformToV2(entry);
    expect(result.critic_reviews).toBe(reviews);
  });

  it('omits the key entirely on a no-match track row (parity with pre-1870)', () => {
    const entry = createTrackEntry(); // critic_reviews undefined
    const result = transformToV2(entry);
    expect(result).not.toHaveProperty('critic_reviews');
  });

  it('omits the key on an empty critic_reviews array (defensive)', () => {
    const entry = createTrackEntry({ critic_reviews: [] });
    const result = transformToV2(entry);
    expect(result).not.toHaveProperty('critic_reviews');
  });

  it('never emits critic_reviews on a non-track (marker) row', () => {
    const reviews = [makeReview()];
    const entry = createTrackEntry({
      entry_type: 'show_start',
      critic_reviews: reviews,
    });
    const result = transformToV2(entry);
    expect(result).not.toHaveProperty('critic_reviews');
  });
});
