/**
 * `runFill`'s execute loop: how it ends, and what it tells the operator about
 * where to resume.
 *
 * Two things here have no equivalent in the `streaming-columns-drain` donor.
 *
 * That job's cohort empties as it runs, so "re-run it" is its resume. This
 * one keeps every row that did not get a bio, so it resumes by cursor — and a
 * cursor walks straight past any row LML failed to answer for. Hence
 * `resume_after_album_id`, which stops advancing at the first indeterminate
 * row, and the abort after N consecutive batches with no answer at all.
 *
 * The rest pins the loop itself, for the reason the donor's own test gives:
 * its first cut had the pause polarity inverted, broke out on batch one, and
 * exited 0 with a clean-looking summary.
 *
 * @see WXYC/Backend-Service#2775
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const waitForQuietPeriod = jest.fn<() => Promise<boolean>>();

jest.mock('@wxyc/lml-client', () => ({
  ...jest.requireActual('@wxyc/lml-client'),
  bulkLookupMetadata: jest.fn(),
}));
jest.mock('@wxyc/database', () => {
  // Mirrors `shared/database/src/live-activity.ts`, declared inside the
  // factory (jest forbids out-of-scope references) and re-exported so the
  // tests throw the REAL type the job branches on.
  class LiveActivityPauseCeilingExceededError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'LiveActivityPauseCeilingExceededError';
    }
  }
  return {
    buildWaitForQuietPeriod: () => waitForQuietPeriod,
    LiveActivityPauseCeilingExceededError,
    closeDatabaseConnection: jest.fn(),
  };
});
jest.mock('../../../../jobs/album-metadata-bio-fill/cohort', () => ({
  READ_TIMEOUT_DEFAULT: 1000,
  countCohort: jest.fn(),
  countEligible: jest.fn(),
  enumerateCohort: jest.fn(),
  applyBioFill: jest.fn(),
  analyzeAlbumMetadata: jest.fn(),
}));

import { LiveActivityPauseCeilingExceededError } from '@wxyc/database';
import { bulkLookupMetadata as bulkLookupMetadataImport } from '@wxyc/lml-client';
import * as cohort from '../../../../jobs/album-metadata-bio-fill/cohort';
import {
  ConsecutiveFailedBatchesError,
  INDETERMINATE_IDS_REPORT_CAP,
  __resetStopForTesting,
  requestStop,
  runFill,
  type FillOptions,
} from '../../../../jobs/album-metadata-bio-fill/job';

const bulkLookupMetadata = bulkLookupMetadataImport as unknown as jest.Mock;
const countCohort = cohort.countCohort as unknown as jest.Mock;
const countEligible = cohort.countEligible as unknown as jest.Mock;
const enumerateCohort = cohort.enumerateCohort as unknown as jest.Mock;
const applyBioFill = cohort.applyBioFill as unknown as jest.Mock;
const analyzeAlbumMetadata = cohort.analyzeAlbumMetadata as unknown as jest.Mock;

const OPTIONS: FillOptions = {
  batchSize: 2,
  ratePerMin: 60_000, // effectively no inter-batch sleep
  budgetMs: 25_000,
  readTimeoutMs: 1000,
  maxAlbums: 0,
  afterAlbumId: 0,
  maxConsecutiveFailedBatches: 3,
  liveActivityLookbackSeconds: 300,
  liveActivityPauseMs: 30_000,
  liveActivityMaxPauseMs: 1_800_000,
  execute: true,
};

/** Candidates with the given album ids; the card id is the album id + 1000. */
const albums = (...ids: number[]) =>
  ids.map((id) => ({ album_id: id, legacy_release_id: id + 1000, artist_name: 'Juana Molina', album_title: 'DOGA' }));

type Outcome = 'fill' | 'no_match' | 'shed';

/**
 * Script LML's answers by album id. Each bulk call is answered from the
 * `artist`/`album` items it was sent, in order, so the script survives any
 * batching. An album with no entry gets a `fill`.
 */
const scriptLml = (outcomes: Record<number, Outcome | 'throw'> = {}, enumerated: number[]) => {
  let cursor = 0;
  bulkLookupMetadata.mockImplementation((items: unknown) => {
    const ids = enumerated.slice(cursor, cursor + (items as unknown[]).length);
    cursor += ids.length;
    if (ids.some((id) => outcomes[id] === 'throw')) return Promise.reject(new Error('ECONNRESET'));
    return Promise.resolve({
      results: ids.map((id, index) => {
        const outcome = outcomes[id] ?? 'fill';
        if (outcome === 'shed') return { index, status: 'shed_breaker_open', lookup: { results: [] } };
        if (outcome === 'no_match') return { index, status: 'no_match', lookup: null };
        return {
          index,
          status: 'match',
          lookup: {
            search_type: 'direct',
            results: [
              {
                library_item: { id: id + 1000 },
                artwork: { release_id: 1, release_url: 'https://www.discogs.com/release/1', artist_bio: 'A bio.' },
              },
            ],
          },
        };
      }),
    });
  });
};

const run = (ids: number[], outcomes: Record<number, Outcome | 'throw'> = {}, options: Partial<FillOptions> = {}) => {
  enumerateCohort.mockResolvedValue(albums(...ids) as never);
  scriptLml(outcomes, ids);
  return runFill({ ...OPTIONS, ...options });
};

beforeEach(() => {
  jest.clearAllMocks();
  // `stopRequested` is module state; a test that flips it must not leak.
  __resetStopForTesting();
  waitForQuietPeriod.mockResolvedValue(false);
  countCohort.mockResolvedValueOnce(100 as never).mockResolvedValue(96 as never);
  countEligible.mockResolvedValue(98 as never);
  applyBioFill.mockResolvedValue(true as never);
});

describe('runFill — a completed run', () => {
  it('walks every batch, totals the verdicts, and re-counts the cohort afterwards', async () => {
    const summary = await run([1, 2, 3, 4, 5], { 3: 'no_match' });

    expect(bulkLookupMetadata).toHaveBeenCalledTimes(3);
    expect(summary).toMatchObject({
      execute: true,
      stopped_early: false,
      cohortBefore: 100,
      cohortAfter: 96,
      enumerated: 5,
      batches: 3,
      fill: 4,
      filled: 4,
      no_match: 1,
      indeterminate: 0,
      last_album_id: 5,
      resume_after_album_id: 5,
      indeterminate_album_ids: [],
    });
  });

  it('runs ANALYZE after a run that wrote, and not after one that did not', async () => {
    await run([1, 2]);
    expect(analyzeAlbumMetadata).toHaveBeenCalledTimes(1);

    analyzeAlbumMetadata.mockClear();
    await run([1, 2], { 1: 'no_match', 2: 'no_match' });
    expect(analyzeAlbumMetadata).not.toHaveBeenCalled();
  });

  it('never consults the pause on a dry run — it returns before the loop', async () => {
    const summary = await run([1, 2], {}, { execute: false });

    expect(waitForQuietPeriod).not.toHaveBeenCalled();
    expect(bulkLookupMetadata).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ execute: false, stopped_early: false, cohortAfter: 100 });
  });
});

describe('runFill — the resume point', () => {
  it.each([
    // [label, album ids, outcomes, expected resume point, expected indeterminate ids]
    ['advances to the last album when everything was answered', [1, 2, 3, 4], {}, 4, []],
    ['counts a no_match as answered', [1, 2, 3, 4], { 2: 'no_match' }, 4, []],
    ['stops just before a shed in the middle of a batch', [1, 2, 3, 4, 5, 6], { 4: 'shed' }, 3, [4]],
    ['stays at the previous batch when a batch opens with a shed', [1, 2, 3, 4], { 3: 'shed' }, 2, [3]],
    ['never advances again once it has stopped', [1, 2, 3, 4, 5, 6], { 2: 'shed', 5: 'shed' }, 1, [2, 5]],
    ['stays at the previous batch when a whole bulk call throws', [1, 2, 3, 4, 5, 6], { 3: 'throw' }, 2, [3, 4]],
  ] as const)('%s', async (_label, ids, outcomes, resume, indeterminateIds) => {
    const summary = await run([...ids], outcomes);

    expect(summary.resume_after_album_id).toBe(resume);
    expect(summary.indeterminate_album_ids).toEqual(indeterminateIds);
    expect(summary.last_album_id).toBe(ids[ids.length - 1]);
    expect(summary.stopped_early).toBe(false);
  });

  it('holds at the starting cursor when the very first album is unanswered', async () => {
    const summary = await run([101, 102], { 101: 'shed' }, { afterAlbumId: 100 });

    expect(summary.resume_after_album_id).toBe(100);
  });

  it('caps the reported indeterminate ids and still reports the true count', async () => {
    const ids = Array.from({ length: INDETERMINATE_IDS_REPORT_CAP + 50 }, (_, i) => i + 1);

    const summary = await run(ids, { 1: 'throw' }, { batchSize: ids.length });

    expect(summary.indeterminate).toBe(ids.length);
    expect(summary.indeterminate_album_ids).toHaveLength(INDETERMINATE_IDS_REPORT_CAP);
  });
});

describe('runFill — ending early', () => {
  it('STOPS without calling LML when the pause signals stop (returns true)', async () => {
    waitForQuietPeriod.mockResolvedValue(true);

    const summary = await run([1, 2, 3]);

    expect(bulkLookupMetadata).not.toHaveBeenCalled();
    // Without this marker a stop at batch 1 and a completed bounded run
    // produce the same summary.
    expect(summary).toMatchObject({ stopped_early: true, last_album_id: null, resume_after_album_id: 0 });
  });

  it('STOPS before the first batch once a signal has requested it', async () => {
    // The shared pause returns false without consulting `shouldStop` when the
    // probe is disabled, so the loop carries its own guard.
    requestStop();

    const summary = await run([1, 2, 3]);

    expect(bulkLookupMetadata).not.toHaveBeenCalled();
    expect(summary.stopped_early).toBe(true);
  });

  it('REJECTS on the pause ceiling, after finishing the accounting for what it wrote', async () => {
    const ceiling = new LiveActivityPauseCeilingExceededError('Cooperative-pause budget exceeded');
    waitForQuietPeriod.mockResolvedValueOnce(false).mockRejectedValueOnce(ceiling);

    // A normal return here would let `main` log `finished` and exit 0, making
    // an abort at batch 2 indistinguishable from a completed run.
    await expect(run([1, 2, 3, 4])).rejects.toBe(ceiling);

    expect(bulkLookupMetadata).toHaveBeenCalledTimes(1);
    expect(analyzeAlbumMetadata).toHaveBeenCalledTimes(1);
    expect(countCohort).toHaveBeenCalledTimes(2);
  });

  it('REJECTS on any other error out of the pause rather than swallowing it', async () => {
    const other = new Error('sentry transport exploded');
    waitForQuietPeriod.mockRejectedValue(other);

    await expect(run([1, 2])).rejects.toBe(other);
    expect(bulkLookupMetadata).not.toHaveBeenCalled();
  });
});

describe('runFill — LML is not answering', () => {
  it('aborts after N consecutive batches with no answer at all, without asking for the rest', async () => {
    const outcomes = { 1: 'shed', 2: 'shed', 3: 'throw' } as const;

    await expect(run([1, 2, 3, 4, 5, 6, 7, 8], outcomes, { maxConsecutiveFailedBatches: 2 })).rejects.toBeInstanceOf(
      ConsecutiveFailedBatchesError
    );

    // Batches three and four are never sent: carrying on would only walk the
    // cursor through rows LML cannot process.
    expect(bulkLookupMetadata).toHaveBeenCalledTimes(2);
    expect(countCohort).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a fully answered batch in between', { 1: 'shed', 2: 'shed', 5: 'shed', 6: 'shed' }],
    ['a batch with even one answer in between', { 1: 'shed', 2: 'shed', 3: 'shed', 5: 'shed', 6: 'shed' }],
  ] as const)('does not abort when the failures are separated by %s', async (_label, outcomes) => {
    const summary = await run([1, 2, 3, 4, 5, 6, 7, 8], outcomes, { maxConsecutiveFailedBatches: 2 });

    expect(bulkLookupMetadata).toHaveBeenCalledTimes(4);
    expect(summary.stopped_early).toBe(false);
  });
});
