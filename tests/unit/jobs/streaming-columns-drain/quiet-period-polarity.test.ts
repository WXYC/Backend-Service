/**
 * `runDrain`'s cooperative-pause polarity.
 *
 * `buildWaitForQuietPeriod` (`@wxyc/database`, BS#2147) returns a STOP signal,
 * not a proceed signal: `true` means "stop the loop", and the ordinary
 * quiet-and-carry-on case returns `false`. Siblings consume it as
 * `if (await waitForQuietPeriod()) break;`.
 *
 * The first cut of this drain had that inverted, so it broke out on the very
 * first batch and did nothing — while still logging its cohort counts and
 * exiting 0. A production canary caught it only because the run was bounded;
 * an unbounded run would have printed a clean summary that an operator would
 * reasonably have read as a completed drain. Nothing in the previous test
 * suite could see it, because every existing test exercised `runBatch`
 * directly and never went through the loop that calls the pause.
 *
 * So this pins the loop itself, in both directions.
 *
 * @see WXYC/Backend-Service#2295
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const waitForQuietPeriod = jest.fn<() => Promise<boolean>>();

jest.mock('@wxyc/lml-client', () => ({ bulkLookupMetadata: jest.fn() }));
jest.mock('@wxyc/database', () => ({
  db: {
    // Both count queries and the enumeration run inside a transaction whose
    // `tx.execute` is called twice: the SET LOCAL, then the real statement.
    transaction: jest.fn((cb: (tx: { execute: () => Promise<unknown> }) => Promise<unknown>) => {
      let call = 0;
      return cb({
        execute: () => {
          call += 1;
          // First call is the SET LOCAL statement_timeout, second is the real
          // statement. Returns a resolved promise rather than being `async` so
          // the no-await lint rule stays satisfied.
          return Promise.resolve(call === 1 ? [] : mockRows);
        },
      });
    }),
    execute: jest.fn(() => Promise.resolve([{ album_id: 1 }])),
  },
  buildWaitForQuietPeriod: () => waitForQuietPeriod,
  resolveLiveActivityPauseMs: () => 30_000,
  resolveLiveActivityMaxPauseMs: () => 1_800_000,
  LIVE_ACTIVITY_MAX_PAUSE_MS_ENV: 'LIVE_ACTIVITY_MAX_PAUSE_MS',
  requirePositiveInt: (_raw: unknown, _name: string, fallback: number) => fallback,
  requireNonNegativeInt: (_raw: unknown, _name: string, fallback: number) => fallback,
  closeDatabaseConnection: jest.fn(),
}));

/** Swapped per-test: the count queries want `[{n}]`, the enumeration wants rows. */
let mockRows: unknown = [{ n: 1 }];

import { bulkLookupMetadata as bulkLookupMetadataImport } from '@wxyc/lml-client';
import { runDrain, type DrainOptions } from '../../../../jobs/streaming-columns-drain/job';

const bulkLookupMetadata = bulkLookupMetadataImport as unknown as jest.Mock;

const OPTIONS: DrainOptions = {
  batchSize: 5,
  ratePerMin: 60_000, // effectively no inter-batch sleep
  budgetMs: 25_000,
  readTimeoutMs: 1000,
  maxAlbums: 0,
  liveActivityLookbackSeconds: 300,
  liveActivityPauseMs: 30_000,
  liveActivityMaxPauseMs: 1_800_000,
  execute: true,
};

describe('runDrain — cooperative-pause polarity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // One candidate album; the counts read the same mocked rows, which is fine
    // because only the loop's behaviour is under test here.
    mockRows = [{ album_id: 1, artist_name: 'Juana Molina', album_title: 'DOGA', n: 1 }];
    bulkLookupMetadata.mockResolvedValue({ results: [{ index: 0, status: 'no_match', lookup: null }] } as never);
  });

  it('RUNS the batch when the helper reports no reason to stop (returns false)', async () => {
    waitForQuietPeriod.mockResolvedValue(false);

    const summary = await runDrain(OPTIONS);

    // The regression: with the polarity inverted this was 0 calls and a
    // summary of all-zeros that still looked like a successful run.
    expect(bulkLookupMetadata).toHaveBeenCalledTimes(1);
    expect(summary.no_match).toBe(1);
  });

  it('STOPS without calling LML when the helper signals stop (returns true)', async () => {
    waitForQuietPeriod.mockResolvedValue(true);

    const summary = await runDrain(OPTIONS);

    expect(bulkLookupMetadata).not.toHaveBeenCalled();
    expect(summary.match + summary.no_match + summary.indeterminate).toBe(0);
  });

  it('ends the run with its partial totals when the pause ceiling throws', async () => {
    // The shared helper throws rather than returning once the cumulative pause
    // budget is exhausted. The drain is resumable, so a partial run is a normal
    // outcome — it must report numbers, not unwind bare to main().
    waitForQuietPeriod.mockRejectedValue(new Error('Cooperative-pause budget exceeded'));

    await expect(runDrain(OPTIONS)).resolves.toMatchObject({ execute: true });
    expect(bulkLookupMetadata).not.toHaveBeenCalled();
  });

  it('never consults the pause at all on a dry run — it returns before the loop', async () => {
    waitForQuietPeriod.mockResolvedValue(false);

    await runDrain({ ...OPTIONS, execute: false });

    expect(waitForQuietPeriod).not.toHaveBeenCalled();
    expect(bulkLookupMetadata).not.toHaveBeenCalled();
  });
});
