/**
 * `runDrain`'s cooperative-pause polarity, and how the loop ends.
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
 * So this pins the loop itself: both polarities, both ways out of it, and the
 * property that ties them together — a run that ended early must never be
 * reportable as a completed one, whether the operator is reading the summary
 * object, the logs, or the exit code.
 *
 * @see WXYC/Backend-Service#2295
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const waitForQuietPeriod = jest.fn<() => Promise<boolean>>();

jest.mock('@wxyc/lml-client', () => ({ bulkLookupMetadata: jest.fn() }));
jest.mock('@wxyc/database', () => {
  // Mirrors `shared/database/src/live-activity.ts` — declared inside the
  // factory (jest forbids out-of-scope references) and re-exported so the
  // tests below can throw the REAL type the job branches on, rather than a
  // bare Error that would pass while the `instanceof` labelling regressed.
  class LiveActivityPauseCeilingExceededError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'LiveActivityPauseCeilingExceededError';
    }
  }
  return {
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
    LiveActivityPauseCeilingExceededError,
    resolveLiveActivityPauseMs: () => 30_000,
    resolveLiveActivityMaxPauseMs: () => 1_800_000,
    LIVE_ACTIVITY_MAX_PAUSE_MS_ENV: 'LIVE_ACTIVITY_MAX_PAUSE_MS',
    requirePositiveInt: (_raw: unknown, _name: string, fallback: number) => fallback,
    requireNonNegativeInt: (_raw: unknown, _name: string, fallback: number) => fallback,
    closeDatabaseConnection: jest.fn(),
  };
});

/** Swapped per-test: the count queries want `[{n}]`, the enumeration wants rows. */
let mockRows: unknown = [{ n: 1 }];

import { bulkLookupMetadata as bulkLookupMetadataImport } from '@wxyc/lml-client';
import { LiveActivityPauseCeilingExceededError } from '@wxyc/database';
import {
  runDrain,
  requestStop,
  __resetStopForTesting,
  type DrainOptions,
} from '../../../../jobs/streaming-columns-drain/job';

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
    // `stopRequested` is module state, so a test that flips it would otherwise
    // leak into every test after it.
    __resetStopForTesting();
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
    expect(summary.stopped_early).toBe(false);
  });

  it('STOPS without calling LML when the helper signals stop (returns true)', async () => {
    waitForQuietPeriod.mockResolvedValue(true);

    const summary = await runDrain(OPTIONS);

    expect(bulkLookupMetadata).not.toHaveBeenCalled();
    expect(summary.match + summary.no_match + summary.indeterminate).toBe(0);
    // Without this marker a stop at batch 1 of 890 and a completed bounded run
    // produce identical summaries.
    expect(summary.stopped_early).toBe(true);
  });

  it('STOPS before the first batch once a signal has requested it', async () => {
    // The shared pause returns `false` without consulting `shouldStop` when the
    // probe is disabled, so the loop carries its own guard.
    waitForQuietPeriod.mockResolvedValue(false);
    requestStop();

    const summary = await runDrain(OPTIONS);

    expect(bulkLookupMetadata).not.toHaveBeenCalled();
    expect(summary.stopped_early).toBe(true);
  });

  it('REJECTS when the pause ceiling throws, so the run cannot exit 0', async () => {
    // The shared helper throws rather than returning once the cumulative pause
    // budget is exhausted. Reporting partial totals is right; reporting them
    // through a normal return is not — `main` would log `finished` and leave
    // `process.exitCode` at 0, making a 3-of-890-batch abort indistinguishable
    // from a completed drain. The accounting happens first, then it rethrows.
    const ceiling = new LiveActivityPauseCeilingExceededError('Cooperative-pause budget exceeded');
    waitForQuietPeriod.mockRejectedValue(ceiling);

    await expect(runDrain(OPTIONS)).rejects.toBe(ceiling);
    expect(bulkLookupMetadata).not.toHaveBeenCalled();
  });

  it('REJECTS on any other error out of the pause, rather than reporting it as a budget abort', async () => {
    // `onProbeError` runs inside the probe's own catch, so a throwing Sentry
    // client surfaces here. It must not be swallowed, and it must not be
    // labelled as the ceiling — that would point an operator at the wrong knob.
    const other = new Error('sentry transport exploded');
    waitForQuietPeriod.mockRejectedValue(other);

    await expect(runDrain(OPTIONS)).rejects.toBe(other);
    expect(bulkLookupMetadata).not.toHaveBeenCalled();
  });

  it('never consults the pause at all on a dry run — it returns before the loop', async () => {
    waitForQuietPeriod.mockResolvedValue(false);

    const summary = await runDrain({ ...OPTIONS, execute: false });

    expect(waitForQuietPeriod).not.toHaveBeenCalled();
    expect(bulkLookupMetadata).not.toHaveBeenCalled();
    expect(summary.stopped_early).toBe(false);
  });
});
