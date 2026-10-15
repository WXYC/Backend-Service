/**
 * The re-ask's knobs and flags (BS#3144). The parsers are copied from the bio
 * fill (decision 6 on BS#3137), so this table mirrors its `job.test.ts`: a
 * value that does not parse is an error, never a default.
 *
 * @see WXYC/Backend-Service#3137
 */

import { describe, it, expect } from '@jest/globals';
import { BULK_LOOKUP_INPUT_CAP } from '@wxyc/lml-client';
import { ALBUM_IDS_CAP, resolveMode, resolveOptions } from '../../../../jobs/album-metadata-reask/job';

const FILES = {
  REASK_PIN_FILE: '/data/pins.csv',
  REASK_REMOVED_FILE: '/data/removed.csv',
  REASK_GRADES_FILE: '/data/grades.csv',
};

const resolve = (env: Record<string, string | undefined> = {}, args: string[] = []) =>
  resolveOptions({ ...FILES, ...env }, args);

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
      includeRestored: false,
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
      REASK_INCLUDE_RESTORED: '1',
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
      includeRestored: true,
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
    // Only `1` lifts the hold: a typo read as "no" would hide the mistake, read as "yes" would re-ask a restore.
    ['REASK_INCLUDE_RESTORED', 'yes'],
    ['REASK_INCLUDE_RESTORED', '2'],
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
    expect(() => resolve({ [name]: value })).toThrow(name);
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
    expect(resolve({ REASK_ALBUM_IDS: ids(ALBUM_IDS_CAP) }).albumIds).toHaveLength(ALBUM_IDS_CAP);
    expect(() => resolve({ REASK_ALBUM_IDS: ids(ALBUM_IDS_CAP + 1) })).toThrow(/at most 200/);
  });

  it.each([
    ['a list at or below the cursor', { REASK_ALBUM_IDS: '101,102', REASK_ALBUM_AFTER_ID: '102' }],
    ['a cap equal to the list', { REASK_ALBUM_IDS: '101,102,103', REASK_MAX_ALBUMS: '3' }],
  ])('accepts %s', (_label, env) => {
    expect(() => resolve(env)).not.toThrow();
  });

  it.each([
    [
      'a listed id above the cursor',
      { REASK_ALBUM_IDS: '101,102', REASK_ALBUM_AFTER_ID: '101' },
      '102 is above REASK_ALBUM_AFTER_ID=101',
    ],
    [
      'a cap smaller than the list',
      { REASK_ALBUM_IDS: '101,102,103', REASK_MAX_ALBUMS: '2' },
      'REASK_MAX_ALBUMS=2 is smaller than the 3 listed ids',
    ],
  ])('refuses %s, and names it', (_label, env, error) => {
    expect(() => resolve(env)).toThrow(error);
  });

  it.each([
    [[]],
    [['node', 'job.js']],
    // `album-level-backfill` takes `--dry-run`; that muscle memory must still get a dry run.
    [['node', 'job.js', '--dry-run']],
  ])('runs the dry run for argv %j', (args) => {
    expect(() => resolve({}, args)).not.toThrow();
  });

  // Refused before the input files are required.
  it.each([
    [['--execute'], '--execute is not available yet; it lands with #3151'],
    [['--preview'], '--preview is not available yet; it lands with #3150'],
    // `--catalog-pass` and `--restore` are their own modes (`resolveMode`); the dry run never takes them.
    [['--catalog-pass', 'run-1'], 'Unknown flag --catalog-pass'],
    [['--restore', 'run-1'], 'Unknown flag --restore'],
    // A typo must not fall through to a run.
    [['--exectue'], 'Unknown flag --exectue'],
  ])('refuses argv %j', (flags, error) => {
    expect(() => resolveOptions({}, ['node', 'job.js', ...flags])).toThrow(error);
  });
});

describe('resolveMode', () => {
  const mode = (flags: string[], env: Record<string, string | undefined> = {}) =>
    resolveMode(env, ['node', 'job.js', ...flags]);

  it('is the dry run with no mode flag, with its own options', () => {
    expect(mode([], FILES)).toEqual({ mode: 'dry-run', options: resolveOptions(FILES, []) });
  });

  // The pass needs no input file: it reads only the run's backup rows.
  it.each([
    ['the 30 s default', {}, 30_000],
    ['REASK_CATALOG_STATEMENT_TIMEOUT_MS', { REASK_CATALOG_STATEMENT_TIMEOUT_MS: '45000' }, 45_000],
  ])('takes --catalog-pass <run_id> with %s', (_label, env, statementTimeoutMs) => {
    // Surrounding whitespace from a copied id is trimmed.
    expect(mode(['--catalog-pass', ' reask-2026-10-14-a '], env)).toEqual({
      mode: 'catalog-pass',
      options: { runId: 'reask-2026-10-14-a', statementTimeoutMs },
    });
  });

  it.each([
    [['--catalog-pass'], '--catalog-pass needs the run_id'],
    [['--catalog-pass', '  '], '--catalog-pass needs the run_id'],
    [['--catalog-pass', '--execute'], '--catalog-pass needs the run_id'],
    [['--catalog-pass', 'run-1', '--execute'], '--catalog-pass takes only a run_id; also got --execute'],
    [['--dry-run', '--catalog-pass', 'run-1'], '--catalog-pass takes only a run_id; also got --dry-run'],
    [['--catalog-pass', 'run-1', 'run-2'], '--catalog-pass takes only a run_id; also got run-2'],
  ])('refuses argv %j', (flags, error) => {
    expect(() => mode(flags)).toThrow(error);
  });

  // The restore needs no input file either: it reads only the run's backup rows. Dry run unless `--execute`.
  it.each([
    [
      'a dry run under the five-minute default',
      ['--restore', ' run-1 '],
      {},
      { execute: false, albumIds: [] },
      300_000,
    ],
    ['--execute', ['--restore', 'run-1', '--execute'], {}, { execute: true, albumIds: [] }, 300_000],
    [
      '--album-ids, sorted and deduplicated, before or after --execute',
      ['--execute', '--restore', 'run-1', '--album-ids', '9, 7,9'],
      {},
      { execute: true, albumIds: [7, 9] },
      300_000,
    ],
    [
      'REASK_RESTORE_STATEMENT_TIMEOUT_MS',
      ['--restore', 'run-1'],
      { REASK_RESTORE_STATEMENT_TIMEOUT_MS: '60000' },
      { execute: false, albumIds: [] },
      60_000,
    ],
  ])('takes --restore <run_id> with %s', (_label, flags, env, rest, statementTimeoutMs) => {
    expect(mode(flags, env)).toEqual({
      mode: 'restore',
      options: { runId: 'run-1', ...rest, statementTimeoutMs },
    });
  });

  it.each([
    [['--restore'], '--restore needs the run_id'],
    [['--restore', '--execute'], '--restore needs the run_id'],
    [['--restore', 'run-1', '--preview'], '--restore takes only a run_id, --execute, --album-ids; also got --preview'],
    [['--restore', 'run-1', '--catalog-pass', 'run-2'], 'also got --catalog-pass run-2'],
    [['--catalog-pass', 'run-1', '--restore', 'run-2'], '--catalog-pass takes only a run_id; also got --restore run-2'],
    [['--restore', 'run-1', '--album-ids'], '--album-ids needs a value'],
    [['--restore', 'run-1', '--album-ids', '--execute'], '--album-ids needs a value'],
    [['--restore', 'run-1', '--album-ids', '7,x'], 'Invalid --album-ids="7,x"'],
  ])('refuses argv %j', (flags, error) => {
    expect(() => mode(flags)).toThrow(error);
  });

  it.each(['0', '-1', 'thirty'])('rejects REASK_RESTORE_STATEMENT_TIMEOUT_MS=%j', (value) => {
    expect(() => mode(['--restore', 'run-1'], { REASK_RESTORE_STATEMENT_TIMEOUT_MS: value })).toThrow(
      'REASK_RESTORE_STATEMENT_TIMEOUT_MS'
    );
  });

  it.each(['0', '-1', 'thirty'])('rejects REASK_CATALOG_STATEMENT_TIMEOUT_MS=%j', (value) => {
    expect(() => mode(['--catalog-pass', 'run-1'], { REASK_CATALOG_STATEMENT_TIMEOUT_MS: value })).toThrow(
      'REASK_CATALOG_STATEMENT_TIMEOUT_MS'
    );
  });
});
