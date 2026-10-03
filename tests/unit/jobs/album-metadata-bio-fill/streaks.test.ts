/**
 * `advanceStreaks` — one batch's effect on the streaks a run stops itself on
 * (BS#2789).
 *
 * The rules have needed fixing twice, and each edge case used to be reachable
 * only by scripting a whole run through mocked LML and database calls. Pure,
 * so each rule is a row here. `orchestrate.test.ts` still pins how the loop
 * uses the result: the abort carried, captured once, and the no-bio streak
 * handed to `planResume`.
 *
 * @see WXYC/Backend-Service#2775
 */

import { describe, it, expect } from '@jest/globals';
import {
  ConsecutiveFailedBatchesError,
  ConsecutiveNoBioBatchesError,
  NO_STREAKS,
  advanceStreaks,
} from '../../../../jobs/album-metadata-bio-fill/job';

const LIMITS = { maxConsecutiveFailedBatches: 3, maxConsecutiveNoBioBatches: 10 };

/** A batch of 5 with the given verdict counts; everything else zero. */
const batch = (counts: { fill?: number; write_failed?: number; no_bio?: number; indeterminate?: number }) => ({
  batchSize: 5,
  fill: 0,
  write_failed: 0,
  no_bio: 0,
  indeterminate: 0,
  ...counts,
});

describe('advanceStreaks', () => {
  it.each([
    // [label, previous streaks, batch, the streaks after it]
    ['LML: 4 of 5 unanswered counts', { lml: 1 }, batch({ indeterminate: 4, fill: 1 }), { lml: 2 }],
    ['LML: 3 of 5 unanswered resets', { lml: 2 }, batch({ indeterminate: 3, fill: 2 }), { lml: 0 }],
    [
      'database: every attempted write threw counts',
      { database: 1 },
      batch({ fill: 2, write_failed: 2 }),
      { database: 2 },
    ],
    ['database: one write landed resets', { database: 2 }, batch({ fill: 2, write_failed: 1 }), { database: 0 }],
    [
      'database: a batch with no write leaves it',
      { database: 2 },
      batch({ no_bio: 5 }),
      { database: 2, noBio: 1, noBioFrom: 35 },
    ],
    [
      'no-bio: a fill resets it',
      { noBio: 4, noBioFrom: 10 },
      batch({ fill: 1, no_bio: 4 }),
      { noBio: 0, noBioFrom: 10 },
    ],
    [
      'no-bio: a fill-less batch with a no_bio counts',
      { noBio: 4, noBioFrom: 10 },
      batch({ no_bio: 1, indeterminate: 4 }),
      { lml: 1, noBio: 5, noBioFrom: 10 },
    ],
    [
      'no-bio: a batch with neither leaves it',
      { noBio: 4, noBioFrom: 10 },
      batch({ indeterminate: 5 }),
      { lml: 1, noBio: 4, noBioFrom: 10 },
    ],
    [
      'no-bio: a new streak records where it began',
      { noBioFrom: 10 },
      batch({ no_bio: 5 }),
      { noBio: 1, noBioFrom: 35 },
    ],
  ] as const)('%s', (_label, previous, result, after) => {
    const step = advanceStreaks({ ...NO_STREAKS, ...previous }, result, 35, LIMITS);

    expect(step.streaks).toEqual({ ...NO_STREAKS, ...after });
    expect(step.trip).toBeUndefined();
  });

  it.each([
    ['LML', { lml: 2 }, batch({ indeterminate: 5 }), 'lml'],
    ['the database', { database: 2 }, batch({ fill: 3, write_failed: 3 }), 'database'],
  ] as const)('trips the failed-batch abort on %s, and says which', (_label, previous, result, cause) => {
    const step = advanceStreaks({ ...NO_STREAKS, ...previous }, result, 35, LIMITS);

    expect(step.trip?.error).toBeInstanceOf(ConsecutiveFailedBatchesError);
    expect(step.trip).toMatchObject({ step: 'consecutive_failed_batches', extra: { cause } });
    expect(step.noBioStreakStart).toBeUndefined();
  });

  it('trips the no-bio abort at the limit and says where the streak began', () => {
    const step = advanceStreaks({ ...NO_STREAKS, noBio: 9, noBioFrom: 10 }, batch({ no_bio: 4 }), 55, LIMITS);

    expect(step.trip?.error).toBeInstanceOf(ConsecutiveNoBioBatchesError);
    expect(step.trip).toMatchObject({ step: 'consecutive_no_bio_batches', extra: {} });
    expect(step.noBioStreakStart).toBe(10);
  });

  it('throws the failed-batch abort when both trip on one batch, and still says where the no-bio streak began', () => {
    const step = advanceStreaks(
      { ...NO_STREAKS, lml: 2, noBio: 9, noBioFrom: 10 },
      batch({ indeterminate: 4, no_bio: 1 }),
      55,
      LIMITS
    );

    expect(step.trip?.error).toBeInstanceOf(ConsecutiveFailedBatchesError);
    expect(step.noBioStreakStart).toBe(10);
  });

  it('never trips the no-bio abort when its limit is 0', () => {
    const step = advanceStreaks({ ...NO_STREAKS, noBio: 99 }, batch({ no_bio: 5 }), 0, {
      ...LIMITS,
      maxConsecutiveNoBioBatches: 0,
    });

    expect(step.trip).toBeUndefined();
    expect(step.noBioStreakStart).toBeUndefined();
  });
});
