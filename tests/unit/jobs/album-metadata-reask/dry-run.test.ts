/**
 * The re-ask's dry run (BS#3144): load and validate the three input files,
 * count and enumerate the cohort, admit it, and report. The property that
 * matters is that it reads and reports and does nothing else: no LML call, no
 * write. Every later mode is refused until its slice lands.
 *
 * `cohort` is mocked because its SQL has its own spec; this file is about what
 * `runReask` does with what the cohort returns.
 *
 * @see WXYC/Backend-Service#3137
 */

import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

jest.mock('@wxyc/lml-client', () => ({
  ...jest.requireActual('@wxyc/lml-client'),
  bulkLookupMetadata: jest.fn(),
}));
jest.mock('../../../../jobs/album-metadata-reask/cohort', () => ({
  ...jest.requireActual<Record<string, unknown>>('../../../../jobs/album-metadata-reask/cohort'),
  countCohort: jest.fn(),
  enumerateCohort: jest.fn(),
}));
jest.mock('@sentry/node', () => ({
  __esModule: true,
  init: jest.fn(),
  captureException: jest.fn(),
  setTag: jest.fn(),
  close: jest.fn(() => Promise.resolve(true)),
}));

import { db } from '@wxyc/database';
import { bulkLookupMetadata } from '@wxyc/lml-client';
import * as cohort from '../../../../jobs/album-metadata-reask/cohort';
import type { CohortCounts, ReaskCandidate } from '../../../../jobs/album-metadata-reask/cohort';
import { main, resolveOptions, runReask } from '../../../../jobs/album-metadata-reask/job';

const countCohort = cohort.countCohort as unknown as jest.Mock;
const enumerateCohort = cohort.enumerateCohort as unknown as jest.Mock;

const PINS = [
  'library_id,discogs_release_id,source,updated_at',
  '1001,5001,alex-l-2026-masters-api,2026-10-14 09:53:12-07',
  '1002,5002,alex-l-2026,2026-10-14 09:53:12-07',
  '1003,5003,alex-l-2026-masters,2026-10-14 09:53:12-07',
  '1005,5005,alex-l-2026-masters,2026-10-14 09:53:12-07',
].join('\n');
const REMOVED = ['library_id,discogs_release_id,source', '1004,6004,alex-l-2026-masters-api'].join('\n');
const GRADES = [
  'library_id,stored_release_id,pin_release_id,pin_source,stored_title_score,pin_title_score,stored_play_rate,pin_play_rate,excluded_other_plays,excluded_inferred_plays,tier,expected_release_id',
  '1001,4001,5001,alex-l-2026-masters-api,40,95,0.1,0.8,0,0,rebind,',
  '1002,4002,5002,alex-l-2026,80,90,,,3,0,hold_ungradeable,',
  '1003,4003,5003,alex-l-2026-masters,95,60,0.9,0.1,0,1,hold_stored_better,',
  '1004,6004,6004,alex-l-2026-masters-api,70,,,,0,0,rebind,7004',
].join('\n');

// Juana Molina, Jessica Pratt, Stereolab, Cat Power and Chuquimamani-Condori
// from the WXYC example set; card 1005 is in the cohort but not in the manifest.
const candidate = (
  album_id: number,
  legacy_release_id: number,
  stored_release_id: number,
  pin_release_id: number | null,
  pin_source: string,
  artist_name: string,
  album_title: string
): ReaskCandidate => ({
  album_id,
  legacy_release_id,
  discogs_url: `https://www.discogs.com/release/${stored_release_id}`,
  artwork_url: null,
  library_artwork_url: null,
  stored_release_id,
  artist_name,
  album_title,
  reason: pin_release_id === null ? 'pin_removed' : 'pin_mismatch',
  pin_release_id,
  pin_source,
});
const CANDIDATES = [
  candidate(1, 1001, 4001, 5001, 'alex-l-2026-masters-api', 'Juana Molina', 'DOGA'),
  candidate(2, 1002, 4002, 5002, 'alex-l-2026', 'Jessica Pratt', 'On Your Own Love Again'),
  candidate(3, 1003, 4003, 5003, 'alex-l-2026-masters', 'Stereolab', 'Aluminum Tunes'),
  candidate(4, 1004, 6004, null, 'alex-l-2026-masters-api', 'Cat Power', 'Moon Pix'),
  candidate(5, 1005, 4005, 5005, 'alex-l-2026-masters', 'Chuquimamani-Condori', 'Edits'),
];
const COUNTS: CohortCounts = {
  total: 6,
  eligible: 5,
  by_reason_and_source: [{ reason: 'pin_mismatch', source: 'alex-l-2026', n: 1 }],
  excluded: { no_artist_name: 0, discogs_unavailable: 1, removed_stores_other: 2 },
  catalog_cover_mirrors: 3,
};

let dir: string;
let env: Record<string, string>;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'reask-dry-run-'));
  writeFileSync(join(dir, 'pins.csv'), PINS);
  writeFileSync(join(dir, 'removed.csv'), REMOVED);
  writeFileSync(join(dir, 'grades.csv'), GRADES);
  env = {
    REASK_PIN_FILE: join(dir, 'pins.csv'),
    REASK_REMOVED_FILE: join(dir, 'removed.csv'),
    REASK_GRADES_FILE: join(dir, 'grades.csv'),
  };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  jest.clearAllMocks();
  countCohort.mockResolvedValue(COUNTS as never);
  enumerateCohort.mockResolvedValue(CANDIDATES as never);
});

describe('runReask — dry run', () => {
  it('reports the inputs, the cohort, the admission and the batch plan', async () => {
    const summary = await runReask(resolveOptions(env, []));

    expect(summary).toEqual({
      inputs: {
        pins: { sha256: sha256(PINS), rows: 4 },
        removed: { sha256: sha256(REMOVED), rows: 1 },
        grades: { sha256: sha256(GRADES), rows: 4 },
      },
      cohort: COUNTS,
      enumerated: 5,
      admission: {
        asked: 3,
        ungradeable_exception: 1,
        held: { hold_stored_better: 1, hold_unmanifested: 1 },
      },
      batches: 1,
    });
  });

  it('binds the parsed pin and removal rows into the cohort reads, under the cursor and the cap', async () => {
    const options = resolveOptions({ ...env, REASK_MAX_ALBUMS: '25', REASK_ALBUM_AFTER_ID: '53799' }, []);

    await runReask(options);

    const inputs = countCohort.mock.calls[0][0] as cohort.CohortInputs;
    expect(inputs.pins.map((p) => p.library_id)).toEqual([1001, 1002, 1003, 1005]);
    expect(inputs.removed).toEqual([{ library_id: 1004, discogs_release_id: 6004, source: 'alex-l-2026-masters-api' }]);
    expect(countCohort).toHaveBeenCalledWith(inputs, options.readTimeoutMs);
    expect(enumerateCohort).toHaveBeenCalledWith(inputs, {
      limit: 25,
      afterAlbumId: 53799,
      albumIds: [],
      timeoutMs: options.readTimeoutMs,
    });
  });

  it('makes no LML call and issues no statement of its own', async () => {
    await runReask(resolveOptions(env, []));

    expect(bulkLookupMetadata).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('counts batches over the asked rows only', async () => {
    const summary = await runReask(resolveOptions({ ...env, REASK_BULK_BATCH_SIZE: '2' }, []));

    expect(summary.batches).toBe(2);
  });

  it('refuses a malformed input file before any cohort read', async () => {
    writeFileSync(join(dir, 'bad.csv'), 'library_id,discogs_release_id,source\n1004,0,x');

    await expect(runReask(resolveOptions({ ...env, REASK_REMOVED_FILE: join(dir, 'bad.csv') }, []))).rejects.toThrow(
      'removal file line 2'
    );
    expect(countCohort).not.toHaveBeenCalled();
  });

  it.each([
    ['--execute', '#3151'],
    ['--preview', '#3150'],
    ['--restore', '#3148'],
    ['--catalog-pass', '#3146'],
  ])('refuses %s until its slice (%s) lands, and reads nothing', async (flag, issue) => {
    await expect(runReask(resolveOptions(env, ['node', 'job.js', flag]))).rejects.toThrow(
      new RegExp(`${flag} is not available yet.*${issue}`)
    );
    expect(countCohort).not.toHaveBeenCalled();
    expect(enumerateCohort).not.toHaveBeenCalled();
    expect(bulkLookupMetadata).not.toHaveBeenCalled();
  });
});

describe('main', () => {
  const originalExitCode = process.exitCode;
  const originalEnv = process.env;

  afterAll(() => {
    process.exitCode = originalExitCode;
    process.env = originalEnv;
  });

  it.each([
    ['a dry run that finishes', () => env, 0, 'finished'],
    ['a run with no pin file', () => ({}), 1, 'failed'],
  ])('exits %s with code %i and logs %s', async (_label, makeEnv, exitCode, step) => {
    process.env = { ...originalEnv, ...makeEnv() };
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await main();

    expect(process.exitCode).toBe(exitCode);
    const lines = [...stderr.mock.calls, ...stdout.mock.calls]
      .map(([chunk]) => String(chunk))
      .filter((chunk) => chunk.trimStart().startsWith('{'))
      .map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({ step, tool: 'album-metadata-reask' }));
    stderr.mockRestore();
    stdout.mockRestore();
  });
});
