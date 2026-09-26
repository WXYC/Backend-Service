/**
 * Unit tests for jobs/flowsheet-no-match-recheck job.ts — the BS#2222
 * two-read composition, which is where this job's cursor mechanism actually
 * lives (`orchestrate.ts` stays deliberately cursor-unaware, and `query.ts`
 * has no opinion on how the caller got an offset).
 *
 * The four properties pinned here are the ones the BS#2222 review found
 * wrong, each with a failure mode that no counter would show:
 *
 *   1. BOTH candidate reads issue before EITHER pass. A pass's writes shrink
 *      the ordering, so a read taken after one has run is a read at a
 *      silently different position.
 *   2. The head read sits at the HEAD cursor (its own small rotating offset),
 *      the tail read at the BS#2218 tail cursor, each with its own LIMIT. A
 *      bare `OFFSET 0` head read re-asks the identical front-of-ordering rows
 *      every run when they transient — the marker is deliberately left
 *      untouched (BS#1977 / BS#2179 review HIGH 2) — which is the exact
 *      starvation the tail cursor exists to escape.
 *   3. Both passes receive the SAME cooperative-pause closure, so they pool
 *      one `LIVE_ACTIVITY_MAX_PAUSE_MS` ceiling. A split ceiling let the
 *      first pass throw `LiveActivityPauseCeilingExceededError` past the
 *      second one entirely.
 *   4. The TAIL pass runs first, so a run cut short by the pause ceiling
 *      costs the head its turn rather than the starvation guard and the
 *      historical-cohort drain.
 *
 * Importing job.ts is inert: the `void main()` auto-invoke is gated on
 * `NODE_ENV !== 'test'`, and `@wxyc/database` resolves to the unit config's
 * mock.
 */
import { jest } from '@jest/globals';

import type {
  Candidate,
  LookupFn,
  MarkAttemptedFn,
  RunResult,
  Totals,
  WriteFn,
  runNoMatchRecheck,
} from '../../../../jobs/flowsheet-no-match-recheck/orchestrate';
import {
  resolveHeadSliceConfig,
  runRecheckPasses,
  type RecheckPassDeps,
  type RecheckPassPlan,
} from '../../../../jobs/flowsheet-no-match-recheck/job';
import { BATCH_SIZE_DEFAULT, HEAD_SLICE_DEFAULT } from '../../../../jobs/flowsheet-no-match-recheck/query';

const candidate = (id: number): Candidate => ({
  id,
  artist_name: 'Chuquimamani-Condori',
  album_title: 'Edits',
  track_title: 'Call Your Name',
  album_id: null,
});

const zeroTotals = (): Totals => ({
  scanned: 0,
  resolved: 0,
  resolved_dry: 0,
  unresolved: 0,
  trust_rejected: 0,
  lml_error: 0,
  raced: 0,
  db_error: 0,
});

/** Every row in this pass got a definitive no-match — i.e. all of them departed. */
const allDeparted = (candidates: Candidate[]): Totals => ({
  ...zeroTotals(),
  scanned: candidates.length,
  unresolved: candidates.length,
});

/** Every row in this pass transiented — i.e. all of them stayed candidates. */
const allTransient = (candidates: Candidate[]): Totals => ({
  ...zeroTotals(),
  scanned: candidates.length,
  lml_error: candidates.length,
});

type Harness = {
  deps: RecheckPassDeps;
  /** Ordered log of every read and pass, so read-before-write ordering is assertable. */
  events: string[];
  /** The `waitForQuietPeriod` each pass was handed, to prove it is one shared closure. */
  handedWaiters: Array<(() => Promise<boolean>) | undefined>;
  loadCandidates: jest.Mock<RecheckPassDeps['loadCandidates']>;
  runRecheck: jest.Mock<typeof runNoMatchRecheck>;
  waitForQuietPeriod: () => Promise<boolean>;
};

/**
 * A harness whose reads return `rows[offset .. offset+limit)` of one ordered
 * candidate list, so the head/tail windows and their overlap are real rather
 * than stubbed per call.
 */
const harnessOver = (rows: Candidate[], totalsFor: (candidates: Candidate[]) => Totals = allTransient): Harness => {
  const events: string[] = [];
  const handedWaiters: Array<(() => Promise<boolean>) | undefined> = [];
  const waitForQuietPeriod = jest.fn<() => Promise<boolean>>().mockResolvedValue(false);

  const loadCandidates = jest.fn<RecheckPassDeps['loadCandidates']>().mockImplementation((_ttlDays, limit, offset) => {
    events.push(`read(limit=${limit},offset=${offset})`);
    return Promise.resolve(rows.slice(offset, offset + limit));
  });

  const runRecheck = jest.fn<typeof runNoMatchRecheck>().mockImplementation(async (passDeps): Promise<RunResult> => {
    const candidates = await passDeps.loadCandidates();
    events.push(`pass(${candidates.map((row) => row.id).join(',') || 'empty'})`);
    handedWaiters.push(passDeps.waitForQuietPeriod);
    return { totals: totalsFor(candidates) };
  });

  return {
    events,
    handedWaiters,
    loadCandidates,
    runRecheck,
    waitForQuietPeriod,
    deps: {
      loadCandidates,
      runRecheck,
      lookup: jest.fn<LookupFn>(),
      write: jest.fn<WriteFn>(),
      markAttempted: jest.fn<MarkAttemptedFn>(),
      waitForQuietPeriod,
    },
  };
};

const planOf = (overrides: Partial<RecheckPassPlan> = {}): RecheckPassPlan => ({
  noMatchTtlDays: 14,
  headSlice: 4,
  tailBatchSize: 6,
  headCursorOffset: 0,
  tailCursorOffset: 0,
  dryRun: false,
  ...overrides,
});

describe('resolveHeadSliceConfig', () => {
  it('splits the batch at the defaults: 20 head + 180 tail out of 200', () => {
    expect(resolveHeadSliceConfig(HEAD_SLICE_DEFAULT, BATCH_SIZE_DEFAULT)).toEqual({
      headSlice: 20,
      tailBatchSize: 180,
      clamped: false,
    });
  });

  it('caps the head at half the batch, so a misconfiguration cannot crawl the cursor', () => {
    // `batchSize - 1` satisfied "the tail stays non-empty" only literally: a
    // one-row tail advances the BS#2218 cursor one row per run, ~94 years to
    // wrap the measured 137k-row cohort, while every counter reads healthy.
    // Halving the traversal rate is the worst this ceiling permits.
    expect(resolveHeadSliceConfig(200, 200)).toEqual({ headSlice: 100, tailBatchSize: 100, clamped: true });
    expect(resolveHeadSliceConfig(5000, 200)).toEqual({ headSlice: 100, tailBatchSize: 100, clamped: true });
    expect(resolveHeadSliceConfig(101, 200)).toEqual({ headSlice: 100, tailBatchSize: 100, clamped: true });
    // Exactly at the ceiling is not a clamp.
    expect(resolveHeadSliceConfig(100, 200)).toEqual({ headSlice: 100, tailBatchSize: 100, clamped: false });
  });

  it('never lets the tail read drop below half the batch, at any batch size', () => {
    for (const batchSize of [1, 2, 3, 7, 50, 200, 1000]) {
      const { headSlice, tailBatchSize } = resolveHeadSliceConfig(Number.MAX_SAFE_INTEGER, batchSize);
      expect(tailBatchSize).toBeGreaterThanOrEqual(batchSize / 2);
      expect(headSlice + tailBatchSize).toBe(batchSize);
    }
  });

  it('degenerates safely at batchSize 1: no head slice, the whole batch is the tail', () => {
    expect(resolveHeadSliceConfig(20, 1)).toEqual({ headSlice: 0, tailBatchSize: 1, clamped: true });
  });
});

describe('runRecheckPasses (BS#2222)', () => {
  const rows = Array.from({ length: 40 }, (_, index) => candidate(index));

  it('issues BOTH reads before EITHER pass, at their own cursors and limits', async () => {
    const harness = harnessOver(rows);

    await runRecheckPasses(
      planOf({ headSlice: 4, tailBatchSize: 6, headCursorOffset: 8, tailCursorOffset: 20 }),
      harness.deps
    );

    expect(harness.events).toEqual([
      'read(limit=4,offset=8)', // head, at the head cursor
      'read(limit=6,offset=20)', // tail, at the BS#2218 cursor
      'pass(20,21,22,23,24,25)', // tail pass FIRST
      'pass(8,9,10,11)', // head pass second
    ]);
  });

  it('reads the head at its rotating cursor, not at a bare OFFSET 0', async () => {
    const harness = harnessOver(rows);

    await runRecheckPasses(planOf({ headSlice: 4, headCursorOffset: 12 }), harness.deps);

    expect(harness.loadCandidates).toHaveBeenNthCalledWith(1, 14, 4, 12);
  });

  it('hands both passes the SAME pause closure, so they pool one budget instead of splitting it', async () => {
    const harness = harnessOver(rows);

    await runRecheckPasses(planOf(), harness.deps);

    expect(harness.handedWaiters).toHaveLength(2);
    expect(harness.handedWaiters[0]).toBe(harness.waitForQuietPeriod);
    expect(harness.handedWaiters[1]).toBe(harness.waitForQuietPeriod);
    // Nothing may pass a per-pass ceiling alongside it — that is the split
    // this replaced, and the two together would double the real ceiling.
    const passDeps = harness.runRecheck.mock.calls.map((call) => call[0]);
    for (const dep of passDeps) expect(dep.liveActivityMaxPauseMs).toBeUndefined();
  });

  it('runs the tail pass first, so a pause-ceiling abort costs the head rather than the drain', async () => {
    const harness = harnessOver(rows);
    const ceiling = new Error('Cooperative-pause budget exceeded');
    harness.runRecheck.mockImplementationOnce(async (passDeps) => {
      const candidates = await passDeps.loadCandidates();
      harness.events.push(`pass(${candidates.map((row) => row.id).join(',')})`);
      throw ceiling;
    });

    await expect(runRecheckPasses(planOf({ tailCursorOffset: 20 }), harness.deps)).rejects.toThrow(ceiling);

    // Both reads still happened, and the pass that got the budget was the tail.
    expect(harness.events).toEqual(['read(limit=4,offset=0)', 'read(limit=6,offset=20)', 'pass(20,21,22,23,24,25)']);
  });

  it('drops tail rows the head read already covered and reports how many, so the cursor correction cannot double-count', async () => {
    // Overlapping windows: head [0,4), tail [0,6) — the state on a first run,
    // or any run whose tail cursor has wrapped back into the head's window.
    const harness = harnessOver(rows, allDeparted);

    const outcome = await runRecheckPasses(
      planOf({ headSlice: 4, tailBatchSize: 6, headCursorOffset: 0, tailCursorOffset: 0 }),
      harness.deps
    );

    expect(harness.events).toEqual([
      'read(limit=4,offset=0)',
      'read(limit=6,offset=0)',
      'pass(4,5)', // tail, with rows 0-3 deduped away
      'pass(0,1,2,3)', // head
    ]);
    expect(outcome.headRowsInTailWindow).toBe(4);
    expect(outcome.tailTotals.scanned).toBe(2);
    expect(outcome.headTotals.scanned).toBe(4);
  });

  it('reports zero overlap when the windows are disjoint (the steady state)', async () => {
    const harness = harnessOver(rows);

    const outcome = await runRecheckPasses(planOf({ headCursorOffset: 0, tailCursorOffset: 20 }), harness.deps);

    expect(outcome.headRowsInTailWindow).toBe(0);
  });

  it('keeps head and tail totals separate AND returns their merge for the run counter line', async () => {
    const harness = harnessOver(rows, allDeparted);

    const outcome = await runRecheckPasses(
      planOf({ headSlice: 4, tailBatchSize: 6, tailCursorOffset: 20 }),
      harness.deps
    );

    expect(outcome.headTotals.scanned).toBe(4);
    expect(outcome.tailTotals.scanned).toBe(6);
    // Merged for the `finished` log; the cursor math uses the two separately.
    expect(outcome.totals.scanned).toBe(10);
    expect(outcome.totals.unresolved).toBe(10);
  });

  it('labels each pass so the two candidates_loaded lines a run emits are distinguishable', async () => {
    const harness = harnessOver(rows);

    await runRecheckPasses(planOf(), harness.deps);

    // Without the label, the BS#2176 "candidate count / projected LML call
    // volume" line reads as the run's projection when it is one pass's, and an
    // operator reading the first line under-reports the run by the head slice.
    expect(harness.runRecheck.mock.calls.map((call) => call[0].pass)).toEqual(['tail', 'head']);
  });

  it('forwards dryRun to both passes', async () => {
    const harness = harnessOver(rows);

    await runRecheckPasses(planOf({ dryRun: true }), harness.deps);

    const passDeps = harness.runRecheck.mock.calls.map((call) => call[0]);
    expect(passDeps).toHaveLength(2);
    for (const dep of passDeps) expect(dep.dryRun).toBe(true);
  });

  it('skips the head read entirely when the clamp left no head slice', async () => {
    const harness = harnessOver(rows);

    const outcome = await runRecheckPasses(planOf({ headSlice: 0, tailBatchSize: 6 }), harness.deps);

    expect(harness.events).toEqual(['read(limit=6,offset=0)', 'pass(0,1,2,3,4,5)', 'pass(empty)']);
    expect(outcome.headTotals).toEqual(zeroTotals());
    expect(outcome.headRowsInTailWindow).toBe(0);
  });

  it('never stamps a marker itself — every write stays inside the injected orchestrator', async () => {
    // The BS#1977 / BS#2179 review HIGH 2 contract lives in orchestrate.ts:
    // a transient outcome leaves `no_match_recheck_attempted_at` untouched.
    // The head slice must not acquire a second, marker-stamping write path to
    // force its own rotation — the rejected BS#2222 alternative.
    const harness = harnessOver(rows);

    await runRecheckPasses(planOf(), harness.deps);

    expect(harness.deps.markAttempted).not.toHaveBeenCalled();
    expect(harness.deps.write).not.toHaveBeenCalled();
    expect(harness.deps.lookup).not.toHaveBeenCalled();
  });
});
