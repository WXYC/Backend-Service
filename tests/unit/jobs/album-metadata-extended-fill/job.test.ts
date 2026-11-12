/**
 * Options, the dry run and the probe for the BS#1442 extended fill.
 *
 * Neither mode writes. The dry run also makes no LML call, so sizing the job
 * cannot spend Discogs quota; the probe does call LML, for a bounded number of
 * albums, and logs what a write would have added.
 *
 * `cohort` is mocked: its SQL has its own unit and integration specs.
 *
 * @see WXYC/Backend-Service#1442
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@wxyc/lml-client', () => ({
  ...jest.requireActual<Record<string, unknown>>('@wxyc/lml-client'),
  getRelease: jest.fn(),
  getArtistDetails: jest.fn(),
  getPinnedTracklists: jest.fn(),
}));
jest.mock('../../../../jobs/album-metadata-extended-fill/cohort', () => ({
  ...jest.requireActual<Record<string, unknown>>('../../../../jobs/album-metadata-extended-fill/cohort'),
  cohortStats: jest.fn(),
  enumerateCohort: jest.fn(),
}));

import { db } from '@wxyc/database';
import {
  getArtistDetails as getArtistDetailsImport,
  getPinnedTracklists as getPinnedTracklistsImport,
  getRelease as getReleaseImport,
} from '@wxyc/lml-client';
import * as cohort from '../../../../jobs/album-metadata-extended-fill/cohort';
import * as logger from '../../../../jobs/album-metadata-extended-fill/logger';
import { resolveOptions, runFill } from '../../../../jobs/album-metadata-extended-fill/job';
import { EXTENDED_COLUMNS } from '../../../../jobs/album-metadata-extended-fill/map';

const getRelease = getReleaseImport as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const getArtistDetails = getArtistDetailsImport as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const getPinnedTracklists = getPinnedTracklistsImport as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const cohortStats = cohort.cohortStats as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const enumerateCohort = cohort.enumerateCohort as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const log = jest.spyOn(logger, 'log');

const STATS = {
  cohort: 3,
  tracklist: 3,
  genres: 3,
  styles: 3,
  label: 2,
  full_release_date: 3,
  discogs_artist_id: 3,
  artist_image_url: 3,
  bio_tokens: 1,
};

const candidates = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    album_id: i + 1,
    discogs_url: `https://www.discogs.com/release/${1000 + i}`,
    has_bio: true,
    has_wikipedia_url: false,
    missing: [...EXTENDED_COLUMNS],
    legacy_release_id: 5000 + i,
  }));

beforeEach(() => {
  jest.clearAllMocks();
  // No pins unless a test says otherwise.
  getPinnedTracklists.mockImplementation((ids) =>
    Promise.resolve((ids as number[]).map((legacy_release_id) => ({ legacy_release_id, pin: null })))
  );
  cohortStats.mockResolvedValue(STATS);
});

describe('resolveOptions', () => {
  it('defaults to a dry run at 30 calls a minute, a 2,400-album cap and no cursor, list or probe', () => {
    expect(resolveOptions({}, [])).toEqual({
      mode: 'dry_run',
      ratePerMin: 30,
      readTimeoutMs: 300_000,
      maxAlbums: 2400,
      afterAlbumId: 0,
      albumIds: [],
      probeAlbums: 0,
    });
  });

  it('reads every knob from its EXTENDED_FILL_ env var', () => {
    expect(
      resolveOptions(
        {
          EXTENDED_FILL_RATE_PER_MIN: '60',
          EXTENDED_FILL_READ_TIMEOUT_MS: '1000',
          EXTENDED_FILL_MAX_ALBUMS: '25',
          EXTENDED_FILL_ALBUM_AFTER_ID: '53799',
          EXTENDED_FILL_ALBUM_IDS: '101, 53000,101',
          EXTENDED_FILL_PROBE_ALBUMS: '100',
        },
        []
      )
    ).toEqual({
      mode: 'probe',
      ratePerMin: 60,
      readTimeoutMs: 1000,
      maxAlbums: 25,
      afterAlbumId: 53799,
      albumIds: [101, 53000],
      probeAlbums: 100,
    });
  });

  it.each([
    ['EXTENDED_FILL_RATE_PER_MIN', '0'],
    ['EXTENDED_FILL_RATE_PER_MIN', 'thirty'],
    ['EXTENDED_FILL_MAX_ALBUMS', '-1'],
    ['EXTENDED_FILL_ALBUM_AFTER_ID', '1.5'],
    ['EXTENDED_FILL_PROBE_ALBUMS', '-100'],
    ['EXTENDED_FILL_READ_TIMEOUT_MS', '0'],
    // A list that does not parse must not fall back to "no list": that would
    // turn a three-album retry into a run over the whole cohort.
    ['EXTENDED_FILL_ALBUM_IDS', 'retry'],
    ['EXTENDED_FILL_ALBUM_IDS', '101,,102'],
    ['EXTENDED_FILL_ALBUM_IDS', '0'],
    ['EXTENDED_FILL_ALBUM_IDS', '2147483648'],
    ['EXTENDED_FILL_ALBUM_IDS', Array.from({ length: 201 }, (_, i) => i + 1).join(',')],
  ])('refuses %s=%p rather than falling back', (name, value) => {
    expect(() => resolveOptions({ [name]: value }, [])).toThrow(name);
  });

  it('accepts --dry-run and refuses any other argument, so a mistyped or not-yet-built --execute cannot exit 0', () => {
    expect(resolveOptions({}, ['--dry-run']).mode).toBe('dry_run');
    expect(() => resolveOptions({}, ['--execute'])).toThrow(/--execute/);
    expect(() => resolveOptions({}, ['--dryrun'])).toThrow(/--dryrun/);
  });

  it('refuses a listed id above the cursor, and a cap smaller than the list', () => {
    expect(() => resolveOptions({ EXTENDED_FILL_ALBUM_AFTER_ID: '100', EXTENDED_FILL_ALBUM_IDS: '101' }, [])).toThrow(
      /at or below the cursor/
    );
    expect(() => resolveOptions({ EXTENDED_FILL_MAX_ALBUMS: '1', EXTENDED_FILL_ALBUM_IDS: '5,6' }, [])).toThrow(
      /smaller than the 2 listed ids/
    );
  });

  it('refuses --dry-run with a probe count: the dry run promises no LML calls', () => {
    expect(() => resolveOptions({ EXTENDED_FILL_PROBE_ALBUMS: '100' }, ['--dry-run'])).toThrow(/--dry-run/);
    expect(resolveOptions({}, ['--dry-run']).mode).toBe('dry_run');
  });
});

describe('runFill', () => {
  it('dry run: reports the cohort and its NULL columns, makes no LML call and writes nothing', async () => {
    enumerateCohort.mockResolvedValue(candidates(3));

    const summary = await runFill(resolveOptions({}, []));

    expect(summary).toMatchObject({
      mode: 'dry_run',
      cohort: STATS,
      enumerated: 3,
      first_album_id: 1,
      last_album_id: 3,
    });
    expect(enumerateCohort).toHaveBeenCalledWith({ limit: 2400, afterAlbumId: 0, albumIds: [], timeoutMs: 300_000 });
    expect(getRelease).not.toHaveBeenCalled();
    expect(getArtistDetails).not.toHaveBeenCalled();
    expect(getPinnedTracklists).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'info',
      'dry_run_plan',
      expect.stringContaining('no LML calls'),
      expect.anything()
    );
  });

  it('probe: fetches the first N albums under the cursor and list, logs the tally, and writes nothing', async () => {
    enumerateCohort.mockResolvedValue(candidates(2));
    getRelease.mockResolvedValue({
      release_id: 1000,
      artist_id: 82730,
      tracklist: [{ position: 'A1', title: 'x' }],
      cached: true,
    });
    getArtistDetails.mockResolvedValue({
      artist_id: 82730,
      name: 'Juana Molina',
      image_url: 'https://i.discogs.com/a.jpg',
    });

    const summary = await runFill(
      resolveOptions(
        { EXTENDED_FILL_PROBE_ALBUMS: '2', EXTENDED_FILL_RATE_PER_MIN: '60000', EXTENDED_FILL_ALBUM_AFTER_ID: '7' },
        []
      )
    );

    expect(enumerateCohort).toHaveBeenCalledWith({ limit: 2, afterAlbumId: 7, albumIds: [], timeoutMs: 300_000 });
    expect(getRelease).toHaveBeenCalledTimes(2);
    // Both albums share an artist: one fetch.
    expect(getArtistDetails).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      mode: 'probe',
      lml_calls: 3,
      probe: { albums: 2, outcomes: { would_fill: 2 }, would_fill_by_column: { tracklist: 2, artist_image_url: 2 } },
    });
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('info', 'probe_summary', expect.any(String), expect.anything());
  });

  it('probe: asks for the pins once per batch before any release fetch, and skips the albums whose pin disagrees', async () => {
    enumerateCohort.mockResolvedValue(candidates(2));
    // Album 1 stores release 1000 but is pinned to 530321; album 2 has no pin.
    getPinnedTracklists.mockResolvedValue([
      {
        legacy_release_id: 5000,
        pin: { discogs_release_id: 530321, source: 'alex-2026-10', in_cache: true, tracks: [] },
      },
      { legacy_release_id: 5001, pin: null },
    ]);
    getRelease.mockResolvedValue({ release_id: 1001, tracklist: [{ position: 'A1', title: 'x' }], cached: true });

    const summary = await runFill(
      resolveOptions({ EXTENDED_FILL_PROBE_ALBUMS: '2', EXTENDED_FILL_RATE_PER_MIN: '60000' }, [])
    );

    expect(getPinnedTracklists).toHaveBeenCalledTimes(1);
    expect(getPinnedTracklists).toHaveBeenCalledWith([5000, 5001], { caller: 'album-metadata-extended-fill' });
    expect(getRelease).toHaveBeenCalledTimes(1);
    expect(getRelease).toHaveBeenCalledWith(1001, expect.anything());
    expect(summary).toMatchObject({ probe: { outcomes: { pin_disagrees: 1, would_fill: 1 } } });
  });
});
