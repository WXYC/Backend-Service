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
// The unit suite's `@wxyc/database` double (`tests/mocks/database.mock.ts`)
// already carries `LiveActivityPauseCeilingExceededError` verbatim, so the
// tests throw the type the job branches on; only the pause is scripted here.
jest.mock('@wxyc/database', () => ({
  ...jest.requireActual<Record<string, unknown>>('@wxyc/database'),
  buildWaitForQuietPeriod: () => waitForQuietPeriod,
}));
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
import * as logger from '../../../../jobs/album-metadata-bio-fill/logger';
import {
  ConsecutiveFailedBatchesError,
  ConsecutiveNoBioBatchesError,
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
const log = jest.spyOn(logger, 'log');
const captureError = jest.spyOn(logger, 'captureError');

const OPTIONS: FillOptions = {
  batchSize: 2,
  ratePerMin: 60_000, // effectively no inter-batch sleep
  budgetMs: 25_000,
  readTimeoutMs: 1000,
  maxAlbums: 0,
  afterAlbumId: 0,
  maxConsecutiveFailedBatches: 3,
  maxConsecutiveNoBioBatches: 10,
  albumIds: [],
  liveActivityLookbackSeconds: 300,
  liveActivityPauseMs: 30_000,
  liveActivityMaxPauseMs: 1_800_000,
  execute: true,
};

/** Candidates with the given album ids; the card id is the album id + 1000. */
const albums = (...ids: number[]) =>
  ids.map((id) => ({ album_id: id, legacy_release_id: id + 1000, artist_name: 'Juana Molina', album_title: 'DOGA' }));

/** `write_fails` is a `fill` from LML whose UPDATE then throws. `no_bio` is a
 * trusted match with a null bio, which is also what a breaker shed looks like. */
type Outcome = 'fill' | 'no_match' | 'no_bio' | 'shed' | 'write_fails';
type Outcomes = Record<number, Outcome | 'throw'>;

/**
 * Script LML's answers by album id. Every candidate carries the same artist
 * and album, so the items cannot say which album they are; each bulk call is
 * instead matched to the next `items.length` ids of `enumerated`, in order,
 * which holds for any batch size. An album with no entry gets a `fill`.
 */
const scriptLml = (outcomes: Outcomes = {}, enumerated: number[]) => {
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
        const artwork = { release_id: 1, release_url: 'https://www.discogs.com/release/1' };
        return {
          index,
          status: 'match',
          lookup: {
            search_type: 'direct',
            results: [
              {
                library_item: { id: id + 1000 },
                artwork: outcome === 'no_bio' ? artwork : { ...artwork, artist_bio: 'A bio.' },
              },
            ],
          },
        };
      }),
    });
  });
};

const run = (ids: number[], outcomes: Outcomes = {}, options: Partial<FillOptions> = {}) => {
  enumerateCohort.mockResolvedValue(albums(...ids) as never);
  scriptLml(outcomes, ids);
  applyBioFill.mockImplementation((albumId: unknown) =>
    outcomes[albumId as number] === 'write_fails'
      ? Promise.reject(new Error('write CONNECTION_CLOSED'))
      : Promise.resolve(true)
  );
  return runFill({ ...OPTIONS, ...options });
};

/** The fields of the `summary` line an aborted run logs before it rethrows. */
const loggedSummary = (): Record<string, unknown> | undefined =>
  log.mock.calls.find(([, step]) => step === 'summary')?.[3];

beforeEach(() => {
  jest.clearAllMocks();
  // `stopRequested` is module state; a test that flips it must not leak.
  __resetStopForTesting();
  waitForQuietPeriod.mockResolvedValue(false);
  countCohort.mockResolvedValueOnce(100 as never).mockResolvedValue(96 as never);
  countEligible.mockResolvedValue(98 as never);
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

  it('totals a write that threw as write_failed and carries on, without calling it a fill that landed', async () => {
    const summary = await run([1, 2, 3, 4], { 2: 'write_fails' });

    expect(bulkLookupMetadata).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ stopped_early: false, fill: 4, filled: 3, write_failed: 1, indeterminate: 0 });
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
    // A row whose write threw is not settled either. LML answered for it, but
    // walking the cursor past it would leave it bio-less with nobody asking.
    ['stops just before a row whose write threw', [1, 2, 3, 4, 5, 6], { 4: 'write_fails' }, 3, [4]],
    ['lists unanswered rows and failed writes together', [1, 2, 3, 4], { 2: 'write_fails', 3: 'shed' }, 1, [2, 3]],
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

describe('runFill — retrying a list of album ids (BS#2786)', () => {
  it('asks for exactly the listed ids and reports no cursor', async () => {
    const summary = await run([40, 900], {}, { albumIds: [40, 900] });

    expect(enumerateCohort).toHaveBeenCalledWith({
      limit: 0,
      afterAlbumId: 0,
      albumIds: [40, 900],
      timeoutMs: OPTIONS.readTimeoutMs,
    });
    // A cursor that walked a hand-picked list says nothing about the rows in
    // between. Reporting 900 here would invite resuming the chain from it and
    // skipping every album from 41 to 899.
    expect(summary).toMatchObject({ stopped_early: false, filled: 2, last_album_id: 900, resume_after_album_id: null });
  });

  it('still lists what stayed unsettled, for the next retry', async () => {
    const summary = await run([40, 900, 901], { 900: 'shed', 901: 'write_fails' }, { albumIds: [40, 900, 901] });

    expect(summary).toMatchObject({ resume_after_album_id: null, indeterminate_album_ids: [900, 901] });
  });

  it('keeps reporting no cursor when the no-bio guard aborts it', async () => {
    const ids = [40, 41, 900, 901];
    const outcomes: Outcomes = { 40: 'no_bio', 41: 'no_bio', 900: 'no_bio', 901: 'no_bio' };

    await expect(run(ids, outcomes, { albumIds: ids, maxConsecutiveNoBioBatches: 2 })).rejects.toBeInstanceOf(
      ConsecutiveNoBioBatchesError
    );

    expect(loggedSummary()).toMatchObject({ stopped_early: true, resume_after_album_id: null });
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

describe('runFill — batches that settle nothing', () => {
  it.each([
    ['LML answers for no album', { 1: 'shed', 2: 'shed', 3: 'throw' }],
    // A dead database must end the run the same way a dead LML does: through
    // the accounting, after N batches, not by failing every write to the end.
    ['every write throws', { 1: 'write_fails', 2: 'write_fails', 3: 'write_fails', 4: 'write_fails' }],
    ['every album is unanswered or its write throws', { 1: 'shed', 2: 'write_fails', 3: 'write_fails', 4: 'shed' }],
    // The usual shape of a dead database: LML keeps returning its ordinary mix
    // of verdicts, and no write the batch attempts lands.
    [
      'every write throws beside albums with nothing to write',
      { 1: 'no_match', 2: 'write_fails', 3: 'write_fails', 4: 'no_match' },
    ],
  ] as const)(
    'aborts after N consecutive batches in which %s, without asking for the rest',
    async (_label, outcomes) => {
      await expect(run([1, 2, 3, 4, 5, 6, 7, 8], outcomes, { maxConsecutiveFailedBatches: 2 })).rejects.toBeInstanceOf(
        ConsecutiveFailedBatchesError
      );

      // Batches three and four are never sent: carrying on would only walk the
      // cursor through rows the run cannot settle.
      expect(bulkLookupMetadata).toHaveBeenCalledTimes(2);
      expect(countCohort).toHaveBeenCalledTimes(2);
      expect(loggedSummary()).toMatchObject({ stopped_early: true, filled: 0 });
    }
  );

  it('names both causes in the abort, since the counter cannot tell which it was', () => {
    const { message } = new ConsecutiveFailedBatchesError(3);

    expect(message).toMatch(/LML/);
    expect(message).toMatch(/write/);
  });

  it.each([
    ['a fully answered batch', { 1: 'shed', 2: 'shed', 5: 'shed', 6: 'shed' }],
    ['a batch with even one answer', { 1: 'shed', 2: 'shed', 3: 'shed', 5: 'shed', 6: 'shed' }],
    [
      'a batch in which one write landed beside one that threw',
      { 1: 'shed', 2: 'shed', 3: 'write_fails', 5: 'shed', 6: 'shed' },
    ],
    ['a batch with nothing to write', { 1: 'shed', 2: 'shed', 3: 'no_match', 4: 'no_match', 5: 'shed', 6: 'shed' }],
  ] as const)('does not abort when the failures are separated by %s', async (_label, outcomes) => {
    const summary = await run([1, 2, 3, 4, 5, 6, 7, 8], outcomes, { maxConsecutiveFailedBatches: 2 });

    expect(bulkLookupMetadata).toHaveBeenCalledTimes(4);
    expect(summary.stopped_early).toBe(false);
  });
});

describe('runFill — what an abort reports to Sentry', () => {
  // Both guards end through one capture site; each must keep its own step so
  // the two causes stay separable in Sentry.
  it.each([
    ['consecutive_failed_batches', { 1: 'shed', 2: 'shed', 3: 'shed', 4: 'shed' }, { maxConsecutiveFailedBatches: 2 }],
    [
      'consecutive_no_bio_batches',
      { 1: 'no_bio', 2: 'no_bio', 3: 'no_bio', 4: 'no_bio' },
      { maxConsecutiveNoBioBatches: 2 },
    ],
  ] as const)('captures the abort under %s', async (step, outcomes, options) => {
    await expect(run([1, 2, 3, 4], outcomes, options)).rejects.toThrow();

    expect(captureError).toHaveBeenCalledWith(expect.any(Error), step, { batches_done: 2, of: 2 });
  });
});

describe('runFill — LML answers, but never with a bio', () => {
  // LML returns a match with a null bio when its artist-details breaker sheds,
  // which is identical on the wire to an artist with no Discogs profile. A
  // sustained shed therefore fails no batch: every album is `no_bio`, the
  // cursor walks to the end, and the run reports success having filled nothing.
  const noBio = (...ids: number[]): Outcomes => Object.fromEntries(ids.map((id) => [id, 'no_bio' as const]));

  it('aborts after N consecutive all-no_bio batches, with the cursor put back before the streak', async () => {
    await expect(
      run([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], noBio(3, 4, 5, 6, 7, 8), { maxConsecutiveNoBioBatches: 3 })
    ).rejects.toBeInstanceOf(ConsecutiveNoBioBatchesError);

    expect(bulkLookupMetadata).toHaveBeenCalledTimes(4);
    // Every row in the streak looked answered, so the cursor had reached 8. A
    // resume from there would never re-ask the six rows the shed swallowed.
    expect(loggedSummary()).toMatchObject({
      stopped_early: true,
      filled: 2,
      no_bio: 6,
      last_album_id: 8,
      resume_after_album_id: 2,
    });
  });

  it('leaves the cursor where it had already stopped when that is before the streak', async () => {
    await expect(
      run([1, 2, 3, 4, 5, 6, 7, 8], { 1: 'shed', ...noBio(3, 4, 5, 6) }, { maxConsecutiveNoBioBatches: 2 })
    ).rejects.toBeInstanceOf(ConsecutiveNoBioBatchesError);

    expect(loggedSummary()).toMatchObject({ resume_after_album_id: 0, indeterminate_album_ids: [1] });
  });

  it('says what probably happened and which knob to turn if it did not', () => {
    const { message } = new ConsecutiveNoBioBatchesError(10);

    expect(message).toMatch(/breaker/);
    expect(message).toContain('BIO_FILL_MAX_CONSECUTIVE_NO_BIO_BATCHES');
  });

  it.each([
    // [label, outcomes, guard setting]
    ['a batch with one fill in it breaks the streak', noBio(1, 2, 3, 5, 6, 7), 2],
    ['a batch with any other verdict in it breaks the streak', { ...noBio(1, 2, 3, 5, 6), 4: 'no_match' }, 2],
    ['the streak is shorter than the limit', noBio(1, 2, 3, 4, 5, 6), 4],
    // A real cluster of bio-less albums: the operator turns the guard off and resumes.
    ['the guard is disabled with 0', noBio(1, 2, 3, 4, 5, 6, 7, 8), 0],
  ] as const)('does not abort when %s', async (_label, outcomes, maxConsecutiveNoBioBatches) => {
    const summary = await run([1, 2, 3, 4, 5, 6, 7, 8], outcomes, { maxConsecutiveNoBioBatches });

    expect(bulkLookupMetadata).toHaveBeenCalledTimes(4);
    expect(summary).toMatchObject({ stopped_early: false, resume_after_album_id: 8 });
  });
});

describe('runFill — the accounting itself cannot read the database', () => {
  const down = new Error('connect ECONNREFUSED');

  beforeEach(() => {
    countCohort.mockReset();
    countCohort.mockResolvedValueOnce(100 as never).mockRejectedValue(down as never);
  });

  it('still logs the summary, and rejects with the abort it was carrying rather than the re-count error', async () => {
    const outcomes = { 1: 'write_fails', 2: 'write_fails', 3: 'write_fails', 4: 'write_fails' } as const;

    // The database that failed the writes fails the re-count too. Without the
    // summary line the resume point of an aborted run is lost with it.
    await expect(run([1, 2, 3, 4, 5, 6], outcomes, { maxConsecutiveFailedBatches: 2 })).rejects.toBeInstanceOf(
      ConsecutiveFailedBatchesError
    );

    expect(loggedSummary()).toMatchObject({
      stopped_early: true,
      write_failed: 4,
      resume_after_album_id: 0,
      accounting_failed: true,
    });
  });

  it('logs the summary and rejects when a run that finished its loop cannot re-count', async () => {
    await expect(run([1, 2])).rejects.toBe(down);

    // The loop did finish, so this is not `stopped_early`: nothing is left to resume.
    expect(loggedSummary()).toMatchObject({
      stopped_early: false,
      filled: 2,
      resume_after_album_id: 2,
      accounting_failed: true,
    });
  });
});
