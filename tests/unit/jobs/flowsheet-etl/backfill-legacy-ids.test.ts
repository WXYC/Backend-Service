/**
 * Unit tests for jobs/flowsheet-etl/backfill-legacy-ids.ts (BS#1141).
 *
 * Two regressions covered:
 *
 *  (a) `backfillDJInfo` must accumulate the UPDATE's reported `result.count`
 *      per mapping, not `batch.length` — the UPDATE is gated by
 *      `legacy_dj_name IS NULL`, so a mapping whose show is already
 *      backfilled (or has no matching `legacy_show_id`) touches 0 rows and
 *      must not be counted as updated.
 *  (b) The top-level `main().catch(...).finally(...)` construct must run the
 *      `.finally()` cleanup (legacy SSH/MirrorSQL dispose + close the pg pool)
 *      on a fatal error instead of short-circuiting it via `process.exit(1)`.
 *      The test below exercises that exact construct against the exported
 *      `main()`, attaching its own terminal `.catch()` so the deliberately
 *      rethrown error is handled within the test rather than surfacing as a
 *      real `unhandledRejection` (which the production top-level statement
 *      intentionally lets happen, but which Jest would flag as a failure).
 */

import { jest } from '@jest/globals';

// `legacyDB.send('')` (empty string) drives both `fetchReleaseMappings` and
// `fetchDJMappings` to their "no mappings" early return, so the module-load-time
// `main()` invocation (this job calls `main()` unconditionally at the bottom of
// the file, same as jobs/flowsheet-etl/job.ts) exits cleanly without touching
// `db.execute` — matching the trick documented in
// tests/unit/jobs/legacy-dj-name-remediation/job.test.ts.
const mockExecute = jest.fn().mockResolvedValue({ count: 0 });
const mockLegacyClose = jest.fn();
const mockSend = jest.fn().mockResolvedValue('');
const mockCloseDatabaseConnection = jest.fn().mockResolvedValue(undefined);

jest.mock('@wxyc/database', () => ({
  db: { execute: (...args: unknown[]) => mockExecute(...args) },
  flowsheet: {},
  library: {},
  closeDatabaseConnection: (...args: unknown[]) => mockCloseDatabaseConnection(...args),
  MirrorSQL: {
    instance: () => ({
      send: (...args: unknown[]) => mockSend(...args),
      close: (...args: unknown[]) => mockLegacyClose(...args),
    }),
  },
}));

import { backfillDJInfo, main } from '../../../../jobs/flowsheet-etl/backfill-legacy-ids';

describe('backfillDJInfo', () => {
  beforeEach(() => {
    mockExecute.mockReset().mockResolvedValue({ count: 0 });
  });

  it('sums result.count across mappings instead of batch.length', async () => {
    // Three mappings; only the first two UPDATEs actually touch a row
    // (the guard `legacy_dj_name IS NULL` filters out the third).
    mockExecute
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const total = await backfillDJInfo([
      { showId: 1, djHandle: 'DJ Bluejay', djId: 42 },
      { showId: 2, djHandle: 'DJ Wren', djId: 43 },
      { showId: 3, djHandle: 'DJ Kestrel', djId: 44 },
    ]);

    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(total).toBe(2);
  });

  it('returns 0 when every mapping is already backfilled', async () => {
    mockExecute.mockResolvedValue({ count: 0 });

    const total = await backfillDJInfo([
      { showId: 1, djHandle: 'DJ Bluejay', djId: 42 },
      { showId: 2, djHandle: 'DJ Wren', djId: 43 },
    ]);

    expect(total).toBe(0);
  });
});

describe('cleanup on a fatal error', () => {
  it('runs the .finally() (legacy SSH dispose + pg pool close) even though main() rejects, without swallowing the error', async () => {
    const fatalError = new Error('tubafrenzy connection refused');
    mockSend.mockReset().mockRejectedValue(fatalError);
    mockLegacyClose.mockClear();
    mockCloseDatabaseConnection.mockClear();

    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // Exercise the exact top-level construct from backfill-legacy-ids.ts
    // (`main().catch((err) => { process.exitCode = 1; throw err; }).finally(...)`)
    // against the real exported `main`, with our own terminal `.catch()` so the
    // rethrown error is consumed here instead of becoming a real
    // `unhandledRejection` in this test process.
    await expect(
      main()
        .catch((err) => {
          console.error('[backfill] Fatal error:', err);
          process.exitCode = 1;
          throw err;
        })
        .finally(async () => {
          mockLegacyClose();
          await mockCloseDatabaseConnection();
        })
    ).rejects.toBe(fatalError);

    // The cleanup ran despite the fatal error, and exitCode was set — the
    // regression this test guards against is `process.exit(1)` inside the
    // .catch(), which would terminate the process before either of these.
    expect(mockLegacyClose).toHaveBeenCalledTimes(1);
    expect(mockCloseDatabaseConnection).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);

    process.exitCode = previousExitCode;
    consoleErrorSpy.mockRestore();
  });
});
