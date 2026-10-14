/**
 * The re-ask's knobs and flags (BS#3144). The parsers are copied from the bio
 * fill (decision 6 on BS#3137), so this table mirrors its `job.test.ts`: a
 * value that does not parse is an error, never a default.
 *
 * @see WXYC/Backend-Service#3137
 */

import { describe, it, expect } from '@jest/globals';
import { BULK_LOOKUP_INPUT_CAP } from '@wxyc/lml-client';
import { ALBUM_IDS_CAP, resolveOptions } from '../../../../jobs/album-metadata-reask/job';

const FILES = {
  REASK_PIN_FILE: '/data/pins.csv',
  REASK_REMOVED_FILE: '/data/removed.csv',
  REASK_GRADES_FILE: '/data/grades.csv',
};

const resolve = (env: Record<string, string> = {}, args: string[] = []) => resolveOptions({ ...FILES, ...env }, args);

describe('resolveOptions', () => {
  it('defaults to a dry run at the plan pacing, with no cap, cursor, list or seed', () => {
    expect(resolve({}, ['node', 'job.js'])).toEqual({
      pinFile: '/data/pins.csv',
      removedFile: '/data/removed.csv',
      gradesFile: '/data/grades.csv',
      batchSize: 5,
      ratePerMin: 4,
      readTimeoutMs: 300_000,
      maxAlbums: 0,
      afterAlbumId: 0,
      albumIds: [],
      sampleSeed: null,
      maxConsecutiveFailedBatches: 3,
      maxConsecutivePinNotBoundBatches: 3,
      liveActivityLookbackSeconds: 300,
      modes: [],
    });
  });

  it('reads every knob from its env var', () => {
    const options = resolve({
      REASK_BULK_BATCH_SIZE: '10',
      REASK_BULK_RATE_PER_MIN: '2',
      REASK_READ_TIMEOUT_MS: '60000',
      REASK_MAX_ALBUMS: '2400',
      REASK_ALBUM_AFTER_ID: '53799',
      REASK_SAMPLE_SEED: '20261014',
      REASK_MAX_CONSECUTIVE_FAILED_BATCHES: '5',
      REASK_MAX_CONSECUTIVE_PIN_NOT_BOUND_BATCHES: '0',
      LIVE_ACTIVITY_LOOKBACK_SECONDS: '0',
    });

    expect(options).toMatchObject({
      batchSize: 10,
      ratePerMin: 2,
      readTimeoutMs: 60_000,
      maxAlbums: 2400,
      afterAlbumId: 53799,
      sampleSeed: 20261014,
      maxConsecutiveFailedBatches: 5,
      maxConsecutivePinNotBoundBatches: 0,
      liveActivityLookbackSeconds: 0,
    });
  });

  it.each([
    // The three input files have no default: a run that guessed a path would
    // compare against some other pin state.
    ['REASK_PIN_FILE', undefined],
    ['REASK_REMOVED_FILE', ''],
    ['REASK_GRADES_FILE', '  '],
    ['REASK_BULK_BATCH_SIZE', '0'],
    ['REASK_BULK_BATCH_SIZE', 'five'],
    ['REASK_BULK_BATCH_SIZE', String(BULK_LOOKUP_INPUT_CAP + 1)],
    ['REASK_BULK_RATE_PER_MIN', '0'],
    ['REASK_BULK_RATE_PER_MIN', '-1'],
    ['REASK_READ_TIMEOUT_MS', '0'],
    ['REASK_MAX_ALBUMS', '-25'],
    ['REASK_ALBUM_AFTER_ID', '1.5'],
    ['REASK_SAMPLE_SEED', 'random'],
    ['REASK_SAMPLE_SEED', '-1'],
    ['REASK_MAX_CONSECUTIVE_FAILED_BATCHES', '0'],
    ['REASK_MAX_CONSECUTIVE_PIN_NOT_BOUND_BATCHES', '-1'],
    ['REASK_MAX_CONSECUTIVE_PIN_NOT_BOUND_BATCHES', 'three'],
    ['LIVE_ACTIVITY_LOOKBACK_SECONDS', '-1'],
    // A list that does not parse must not fall back to "no list": that would
    // turn a three-album retry into a run over the whole cohort.
    ['REASK_ALBUM_IDS', 'retry'],
    ['REASK_ALBUM_IDS', '101,,102'],
    ['REASK_ALBUM_IDS', '101,102,'],
    ['REASK_ALBUM_IDS', '0'],
    ['REASK_ALBUM_IDS', '-101'],
    ['REASK_ALBUM_IDS', '101.5'],
    ['REASK_ALBUM_IDS', '1e3'],
    ['REASK_ALBUM_IDS', '2147483648'],
    ['REASK_ALBUM_IDS', '[101,102]'],
  ])('rejects %s=%j instead of falling back to a default', (name, value) => {
    const env: Record<string, string | undefined> = { ...FILES, [name]: value };

    expect(() => resolveOptions(env, [])).toThrow(name);
  });

  it.each([
    ['a list', '101,102', [101, 102]],
    ['a single id', '101', [101]],
    ['spaces, a repeat and any order', ' 102 , 7,102 ', [7, 102]],
    ['blank as no list', '  ', []],
  ])('reads REASK_ALBUM_IDS: %s', (_label, raw, albumIds) => {
    expect(resolve({ REASK_ALBUM_IDS: raw }).albumIds).toEqual(albumIds);
  });

  it('bounds the id list at 200, and says what the bound is', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(',');

    expect(ALBUM_IDS_CAP).toBe(200);
    expect(resolve({ REASK_ALBUM_IDS: ids(200) }).albumIds).toHaveLength(200);
    expect(() => resolve({ REASK_ALBUM_IDS: ids(201) })).toThrow(/at most 200/);
  });

  it.each([
    ['carries a list at or below the cursor', { REASK_ALBUM_IDS: '101,102', REASK_ALBUM_AFTER_ID: '102' }, null],
    [
      'refuses a listed id above the cursor',
      { REASK_ALBUM_IDS: '101,102', REASK_ALBUM_AFTER_ID: '101' },
      '102 is above REASK_ALBUM_AFTER_ID=101',
    ],
    [
      'refuses a cap smaller than the list',
      { REASK_ALBUM_IDS: '101,102,103', REASK_MAX_ALBUMS: '2' },
      'REASK_MAX_ALBUMS=2 is smaller than the 3 listed ids',
    ],
    ['allows a cap equal to the list', { REASK_ALBUM_IDS: '101,102,103', REASK_MAX_ALBUMS: '3' }, null],
  ])('%s', (_label, env, error) => {
    if (error) expect(() => resolve(env)).toThrow(error);
    else expect(() => resolve(env)).not.toThrow();
  });

  it.each([
    [['node', 'job.js'], []],
    // `album-level-backfill` takes `--dry-run`; that muscle memory must still get a dry run.
    [['node', 'job.js', '--dry-run'], []],
    [['node', 'job.js', '--execute'], ['--execute']],
    [['node', 'job.js', '--preview'], ['--preview']],
    [
      ['node', 'job.js', '--restore', 'run-1', '--execute'],
      ['--execute', '--restore'],
    ],
    [['node', 'job.js', '--catalog-pass', 'run-1'], ['--catalog-pass']],
  ])('reads the mode flags from %j', (args, modes) => {
    expect(resolve({}, args).modes).toEqual(modes);
  });
});
