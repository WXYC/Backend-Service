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
  LmlAuthError,
  getArtistDetails as getArtistDetailsImport,
  getPinnedTracklists as getPinnedTracklistsImport,
  getRelease as getReleaseImport,
} from '@wxyc/lml-client';
import * as cohort from '../../../../jobs/album-metadata-extended-fill/cohort';
import * as logger from '../../../../jobs/album-metadata-extended-fill/logger';
import {
  __resetStopForTesting,
  handleStopSignal,
  resolveOptions,
  runFill,
} from '../../../../jobs/album-metadata-extended-fill/job';
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
  __resetStopForTesting();
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
      notFoundReleaseIds: [],
      notFoundArtistIds: [],
      maxConsecutiveUnanswered: 10,
      maxConsecutiveNotFound: 10,
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
          EXTENDED_FILL_NOT_FOUND_RELEASE_IDS: '36792451',
          EXTENDED_FILL_NOT_FOUND_ARTIST_IDS: '82730,194',
          EXTENDED_FILL_MAX_CONSECUTIVE_UNANSWERED: '0',
          EXTENDED_FILL_MAX_CONSECUTIVE_NOT_FOUND: '5',
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
      notFoundReleaseIds: [36792451],
      notFoundArtistIds: [194, 82730],
      maxConsecutiveUnanswered: 0,
      maxConsecutiveNotFound: 5,
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
    ['EXTENDED_FILL_NOT_FOUND_RELEASE_IDS', 'x'],
    ['EXTENDED_FILL_NOT_FOUND_ARTIST_IDS', '-3'],
    ['EXTENDED_FILL_MAX_CONSECUTIVE_UNANSWERED', '-1'],
    ['EXTENDED_FILL_MAX_CONSECUTIVE_NOT_FOUND', 'ten'],
  ])('refuses %s=%p rather than falling back', (name, value) => {
    expect(() => resolveOptions({ [name]: value }, [])).toThrow(name);
  });

  it('refuses any argument it does not know, so a mistyped flag cannot exit 0', () => {
    expect(resolveOptions({}, ['--dry-run']).mode).toBe('dry_run');
    expect(() => resolveOptions({}, ['--exectue'])).toThrow(/--exectue/);
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

  it('refuses a probe count smaller than the listed ids, which would drop some unreported', () => {
    expect(() => resolveOptions({ EXTENDED_FILL_PROBE_ALBUMS: '2', EXTENDED_FILL_ALBUM_IDS: '5,6,7' }, [])).toThrow(
      /EXTENDED_FILL_PROBE_ALBUMS=2 is smaller than the 3 listed ids/
    );
  });

  it('--execute selects the write mode, and refuses --dry-run or a probe beside it', () => {
    expect(resolveOptions({}, ['--execute']).mode).toBe('execute');
    expect(() => resolveOptions({}, ['--execute', '--dry-run'])).toThrow(/--execute writes/);
    expect(() => resolveOptions({ EXTENDED_FILL_PROBE_ALBUMS: '5' }, ['--execute'])).toThrow(/--execute writes/);
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

  it('probe: says loudly at start that it spends Discogs quota', async () => {
    enumerateCohort.mockResolvedValue([]);

    await runFill(resolveOptions({ EXTENDED_FILL_PROBE_ALBUMS: '2' }, []));

    expect(log).toHaveBeenCalledWith('warn', 'probe_spends_quota', expect.stringContaining('Discogs quota'), {
      probe_albums: 2,
    });
  });

  it('probe: EXTENDED_FILL_MAX_ALBUMS still caps the run', async () => {
    enumerateCohort.mockResolvedValue([]);

    await runFill(resolveOptions({ EXTENDED_FILL_PROBE_ALBUMS: '5000', EXTENDED_FILL_MAX_ALBUMS: '25' }, []));

    expect(enumerateCohort).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });

  it('probe: an error mid-probe still logs the totals gathered so far, then rethrows', async () => {
    enumerateCohort.mockResolvedValue(candidates(2));
    getRelease
      .mockResolvedValueOnce({ release_id: 1000, tracklist: [{ position: 'A1', title: 'x' }], cached: true })
      .mockRejectedValueOnce(new LmlAuthError('rejected', 401));

    await expect(
      runFill(resolveOptions({ EXTENDED_FILL_PROBE_ALBUMS: '2', EXTENDED_FILL_RATE_PER_MIN: '60000' }, []))
    ).rejects.toBeInstanceOf(LmlAuthError);

    expect(log).toHaveBeenCalledWith(
      'error',
      'probe_summary',
      expect.stringContaining('stopped'),
      expect.objectContaining({ probe: expect.objectContaining({ albums: 1 }), error: 'rejected' })
    );
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

describe('runFill --execute', () => {
  const execute = db.execute as unknown as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

  it('fills each album through the guarded UPDATE, ANALYZEs, and reports next_run', async () => {
    enumerateCohort.mockResolvedValue(candidates(2));
    getRelease.mockImplementation((id) =>
      Promise.resolve({ release_id: id, tracklist: [{ position: 'A1', title: 'x' }], cached: true })
    );
    // The UPDATE's RETURNING: which columns are set afterwards.
    execute.mockResolvedValue([{ tracklist: true }]);

    const summary = await runFill(resolveOptions({ EXTENDED_FILL_RATE_PER_MIN: '60000' }, ['--execute']));

    // Two UPDATEs and the ANALYZE.
    expect(execute).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({
      mode: 'execute',
      lml_calls: 2,
      execute: { outcomes: { filled: 2 }, reached_end: true, next_run: { EXTENDED_FILL_ALBUM_AFTER_ID: 2 } },
    });
  });

  it('a first stop signal ends the run before the next album, with a resumable summary', async () => {
    enumerateCohort.mockResolvedValue(candidates(2));
    handleStopSignal('SIGTERM');

    const summary = await runFill(resolveOptions({}, ['--execute']));

    expect(getRelease).not.toHaveBeenCalled();
    expect(summary.execute).toMatchObject({ processed: 0, stopped_early: true, reached_end: false });
  });

  it('a second stop signal logs and exits 1 without waiting for the album in flight', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    handleStopSignal('SIGINT');
    handleStopSignal('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));

    expect(log).toHaveBeenCalledWith(
      'warn',
      'forced_exit',
      expect.stringContaining('second SIGINT'),
      expect.anything()
    );
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });
});
