/**
 * One album through the extended fill (BS#1442 slice 2): the outcome table
 * keyed on call and status, from the plan's "Cohort and resume".
 *
 * A 404 is only a suspected not-found: LML returns it for a real tombstone but
 * also when its Discogs retry gives up. So the first 404 is carried, and only
 * the same id 404ing again in a later run settles. An artist failure never
 * costs the album its six release columns.
 *
 * The UPDATE itself is mocked here; its SQL runs on a real PostgreSQL in
 * tests/integration/album-metadata-extended-fill-write.spec.js.
 *
 * @see WXYC/Backend-Service#1442
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../../../jobs/album-metadata-extended-fill/write', () => ({
  ...jest.requireActual<Record<string, unknown>>('../../../../jobs/album-metadata-extended-fill/write'),
  writeFill: jest.fn(),
}));

import { LmlAuthError } from '@wxyc/lml-client';
import type { DiscogsArtistDetails, DiscogsReleaseMetadata } from '@wxyc/lml-client';
import type { FillCandidate } from '../../../../jobs/album-metadata-extended-fill/cohort';
import type { Fetched, LmlFetcher } from '../../../../jobs/album-metadata-extended-fill/fetch';
import { NO_PRIOR_NOT_FOUND, fillAlbum } from '../../../../jobs/album-metadata-extended-fill/fill';
import { EXTENDED_COLUMNS } from '../../../../jobs/album-metadata-extended-fill/map';
import type { PinLookup } from '../../../../jobs/album-metadata-extended-fill/pins';
import * as logger from '../../../../jobs/album-metadata-extended-fill/logger';
import * as write from '../../../../jobs/album-metadata-extended-fill/write';

const writeFill = write.writeFill as unknown as jest.Mock<(...args: unknown[]) => Promise<string[] | null>>;
const log = jest.spyOn(logger, 'log');

// The generated DTOs require every defaulted field; the fill reads only these.
const RELEASE = {
  release_id: 1442,
  artist_id: 82730,
  artists: [{ artist_id: 82730, name: 'Juana Molina', join: '' }],
  label: 'Sonamos',
  released: '2024-05-10',
  genres: ['Electronic'],
  styles: ['Experimental'],
  tracklist: [{ position: 'A1', title: 'la paradoja', artists: [] }],
  cached: false,
} as unknown as DiscogsReleaseMetadata;
const ARTIST = {
  artist_id: 82730,
  name: 'Juana Molina',
  image_url: 'https://i.discogs.com/a/82730.jpg',
  profile_tokens: [{ type: 'plainText', text: 'Argentine singer.' }],
} as unknown as DiscogsArtistDetails;

const candidate = (overrides: Partial<FillCandidate> = {}): FillCandidate => ({
  album_id: 7,
  discogs_url: 'https://www.discogs.com/release/1442-DOGA',
  has_bio: true,
  has_wikipedia_url: false,
  missing: [...EXTENDED_COLUMNS],
  legacy_release_id: 39541,
  ...overrides,
});

const ok = <T>(value: T): Fetched<T> => ({ ok: true, value });
const failed = (status: number): Fetched<never> => ({ ok: false, status });

const fetcher = (
  release: Fetched<DiscogsReleaseMetadata>,
  artist: Fetched<DiscogsArtistDetails> = ok(ARTIST)
): LmlFetcher & { release: jest.Mock; artist: jest.Mock } => ({
  release: jest.fn(() => Promise.resolve(release)),
  artist: jest.fn(() => Promise.resolve(artist)),
  pins: jest.fn(() => Promise.resolve(ok([]))),
  calls: () => 0,
});

beforeEach(() => {
  jest.clearAllMocks();
  // The row after the UPDATE: every column set.
  writeFill.mockResolvedValue([...EXTENDED_COLUMNS]);
});

describe('fillAlbum: the outcome table', () => {
  it.each([
    // call     status  prior 404s     outcome                         carried
    ['release', 404, 'none', 'release_not_found_suspected', true],
    ['release', 404, 'release', 'release_not_found', false],
    ['release', 502, 'none', 'release_unanswered', true],
    ['release', 504, 'none', 'release_unanswered', true],
    // A prior 404 settles only a 404, never an unanswered call.
    ['release', 502, 'release', 'release_unanswered', true],
  ] as const)('%s %s (prior 404: %s) -> %s, carried %s, no write', async (_call, status, prior, outcome, carried) => {
    const result = await fillAlbum(candidate(), fetcher(failed(status)), undefined, {
      releaseIds: new Set(prior === 'release' ? [1442] : []),
      artistIds: new Set(),
    });

    expect(result).toMatchObject({ outcome, carried, releaseId: 1442 });
    expect(writeFill).not.toHaveBeenCalled();
  });

  it.each([
    // artist status, prior artist 404, artist outcome, album carried
    [404, false, 'not_found_suspected', true],
    [404, true, 'not_found', false],
    [502, false, 'unanswered', true],
    [504, true, 'unanswered', true],
  ] as const)(
    'artist %s (prior 404: %s) -> artist %s, carried %s, and the six release columns are still written',
    async (status, prior, artist, carried) => {
      const result = await fillAlbum(candidate(), fetcher(ok(RELEASE), failed(status)), undefined, {
        releaseIds: new Set(),
        artistIds: new Set(prior ? [82730] : []),
      });

      expect(result).toMatchObject({ outcome: 'filled', artist, carried, artistId: 82730 });
      expect(result.filled).toEqual([
        'tracklist',
        'genres',
        'styles',
        'label',
        'full_release_date',
        'discogs_artist_id',
      ]);
      expect(writeFill).toHaveBeenCalledWith(
        candidate(),
        expect.objectContaining({ tracklist: RELEASE.tracklist, artist_image_url: null, bio_tokens: null })
      );
    }
  );

  it('release and artist answer -> filled, all eight columns, nothing carried', async () => {
    const result = await fillAlbum(candidate(), fetcher(ok(RELEASE)), undefined, NO_PRIOR_NOT_FOUND);

    expect(result).toMatchObject({ outcome: 'filled', artist: 'answered', carried: false });
    expect(result.filled).toEqual([...EXTENDED_COLUMNS]);
    expect(writeFill).toHaveBeenCalledWith(candidate(), {
      tracklist: RELEASE.tracklist,
      genres: ['Electronic'],
      styles: ['Experimental'],
      label: 'Sonamos',
      full_release_date: '2024-05-10',
      discogs_artist_id: 82730,
      artist_image_url: ARTIST.image_url,
      bio_tokens: ARTIST.profile_tokens,
    });
  });

  it('the guarded UPDATE matching no row -> release_changed, settled', async () => {
    writeFill.mockResolvedValue(null);

    expect(await fillAlbum(candidate(), fetcher(ok(RELEASE)), undefined, NO_PRIOR_NOT_FOUND)).toMatchObject({
      outcome: 'release_changed',
      carried: false,
      filled: [],
    });
  });

  it('the UPDATE throwing -> write_failed, carried, and the error is logged', async () => {
    writeFill.mockRejectedValue(new Error('connection reset'));

    expect(await fillAlbum(candidate(), fetcher(ok(RELEASE)), undefined, NO_PRIOR_NOT_FOUND)).toMatchObject({
      outcome: 'write_failed',
      carried: true,
      filled: [],
    });
    expect(log).toHaveBeenCalledWith('warn', 'write_failed', expect.stringContaining('connection reset'), {
      album_id: 7,
      error: 'connection reset',
    });
  });

  it('reports as filled only the columns the UPDATE actually set, not every value it was given', async () => {
    // The stored artist id differs, so the UPDATE's same-artist CASE leaves the artist columns NULL.
    writeFill.mockResolvedValue(['tracklist', 'genres', 'styles', 'label', 'full_release_date', 'discogs_artist_id']);

    const result = await fillAlbum(candidate(), fetcher(ok(RELEASE)), undefined, NO_PRIOR_NOT_FOUND);

    expect(result.outcome).toBe('filled');
    expect(result.filled).not.toContain('artist_image_url');
    expect(result.filled).not.toContain('bio_tokens');
  });

  it('an UPDATE that set none of the missing columns -> nothing_new', async () => {
    writeFill.mockResolvedValue(['tracklist']);

    const result = await fillAlbum(
      candidate({ missing: ['artist_image_url', 'bio_tokens'] }),
      fetcher(ok(RELEASE)),
      undefined,
      NO_PRIOR_NOT_FOUND
    );

    expect(result).toMatchObject({ outcome: 'nothing_new', filled: [] });
  });

  it('skips the artist fetch when the row is missing no artist column', async () => {
    const lml = fetcher(ok(RELEASE));

    const result = await fillAlbum(candidate({ missing: ['styles'] }), lml, undefined, NO_PRIOR_NOT_FOUND);

    expect(lml.artist).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'filled', artist: 'not_asked', carried: false, filled: ['styles'] });
  });

  it('no missing column gains a value -> nothing_new, and no UPDATE is sent', async () => {
    const result = await fillAlbum(
      candidate({ missing: ['styles'] }),
      fetcher(ok({ ...RELEASE, styles: [] })),
      undefined,
      NO_PRIOR_NOT_FOUND
    );

    expect(result).toMatchObject({ outcome: 'nothing_new', carried: false });
    expect(writeFill).not.toHaveBeenCalled();
  });

  it('never counts bio_tokens as filled for a row with no bio (the UPDATE leaves them NULL)', async () => {
    const result = await fillAlbum(
      candidate({ has_bio: false, missing: ['bio_tokens'] }),
      fetcher(ok(RELEASE)),
      undefined,
      NO_PRIOR_NOT_FOUND
    );

    expect(result.outcome).toBe('nothing_new');
  });

  it.each([
    ['a compilation (artist 194)', { artist_id: 194 }],
    ['two primary artists', { artists: [{ artist_id: 1 }, { artist_id: 2 }] }],
  ])('%s -> no artist fetch, no artist columns, artist not_asked', async (_label, overrides) => {
    const lml = fetcher(ok({ ...RELEASE, ...overrides } as unknown as DiscogsReleaseMetadata));

    const result = await fillAlbum(candidate(), lml, undefined, NO_PRIOR_NOT_FOUND);

    expect(lml.artist).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'filled', artist: 'not_asked', carried: false });
    expect(writeFill).toHaveBeenCalledWith(
      candidate(),
      expect.objectContaining({ discogs_artist_id: null, artist_image_url: null, bio_tokens: null })
    );
  });

  it.each([
    [
      'pin_disagrees',
      { ok: true, pin: { discogs_release_id: 530321, source: 's', in_cache: true, tracks: [] } },
      false,
    ],
    ['pin_unanswered', { ok: false, status: 502 }, true],
  ] as const)('%s -> no release fetch and no write, carried %s', async (outcome, pin, carried) => {
    const lml = fetcher(ok(RELEASE));

    const result = await fillAlbum(candidate(), lml, pin as unknown as PinLookup, NO_PRIOR_NOT_FOUND);

    expect(result).toMatchObject({ outcome, carried });
    expect(lml.release).not.toHaveBeenCalled();
    expect(writeFill).not.toHaveBeenCalled();
  });

  it('a URL with no release id -> no_release_id, settled, no call', async () => {
    const lml = fetcher(ok(RELEASE));

    expect(
      await fillAlbum(
        candidate({ discogs_url: 'https://www.discogs.com/master/9' }),
        lml,
        undefined,
        NO_PRIOR_NOT_FOUND
      )
    ).toMatchObject({ outcome: 'no_release_id', carried: false });
    expect(lml.release).not.toHaveBeenCalled();
  });

  it('lets an LML auth rejection through: it is fatal to the run', async () => {
    const lml = fetcher(ok(RELEASE));
    lml.release.mockImplementation(() => Promise.reject(new LmlAuthError('rejected', 401)));

    await expect(fillAlbum(candidate(), lml, undefined, NO_PRIOR_NOT_FOUND)).rejects.toBeInstanceOf(LmlAuthError);
  });
});
