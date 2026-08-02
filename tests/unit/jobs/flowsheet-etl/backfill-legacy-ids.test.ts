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
 *      The test below exercises the REAL construct as written at the bottom
 *      of backfill-legacy-ids.ts -- not a copy hand-rolled inline in the
 *      test -- by forcing a fresh module evaluation (jest.resetModules() +
 *      dynamic import, same idiom as tests/unit/services/email.test.ts) with
 *      a failing `legacyDB.send`, so a revert to `process.exit(1)` inside
 *      that construct would actually be caught here instead of silently
 *      passing.
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

import { backfillDJInfo } from '../../../../jobs/flowsheet-etl/backfill-legacy-ids';

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
  it('the real top-level main().catch(...).finally(...) construct runs cleanup and sets exitCode without calling process.exit', async () => {
    const fatalError = new Error('tubafrenzy connection refused');

    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Belt-and-suspenders: if a regression reverts the construct to
    // `process.exit(1)`, fail on a clean assertion (`not.toHaveBeenCalled()`)
    // rather than actually tearing down the Jest worker process.
    const processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    mockSend.mockReset().mockRejectedValue(fatalError);
    mockLegacyClose.mockClear();
    mockCloseDatabaseConnection.mockClear();

    // The production top-level statement (`main().catch(...).finally(...)`
    // at the bottom of backfill-legacy-ids.ts) is a floating promise chain by
    // design -- nothing exported hands this test a handle to it, since it
    // only exists as a side effect of module evaluation. Re-trigger it by
    // forcing a fresh module evaluation (jest.resetModules() + dynamic
    // import, same idiom as tests/unit/services/email.test.ts).
    //
    // The chain deliberately rethrows after cleanup, so it settles rejected
    // and unconsumed -- normally a real `unhandledRejection`. That event does
    // not reach listeners registered from inside a Jest test in this repo's
    // setup (confirmed: neither `process.on`/`.once` nor
    // `process.prependOnceListener` ever fire here), so instead this
    // temporarily patches `Promise.prototype.finally` to capture the exact
    // promise `.finally()` returns at the moment the fresh module calls it,
    // then immediately attaches a `.catch()` to it -- consuming it before
    // Node's unhandled-rejection check ever runs, and giving this test a
    // real handle to `await`.
    const originalFinally = Promise.prototype.finally;
    let capturedChain: Promise<unknown> | undefined;
    Promise.prototype.finally = function (this: Promise<unknown>, onFinally?: (() => void) | null): Promise<unknown> {
      const result = originalFinally.call(this, onFinally);
      capturedChain = result;
      return result;
    };

    jest.resetModules();
    try {
      await import('../../../../jobs/flowsheet-etl/backfill-legacy-ids');
    } finally {
      Promise.prototype.finally = originalFinally;
    }

    if (capturedChain === undefined) {
      throw new Error('expected Promise.prototype.finally to have been called during the reimport');
    }
    const reason = await capturedChain.catch((e: unknown) => e);

    // The real `.catch()` handler received our fatalError -- confirms this
    // exercised the actual production construct, not a copy.
    expect(reason).toBe(fatalError);
    expect(consoleErrorSpy).toHaveBeenCalledWith('[backfill] Fatal error:', fatalError);
    // The cleanup ran despite the fatal error, and exitCode was set — the
    // regression this test guards against is `process.exit(1)` inside the
    // .catch(), which would terminate the process before either of these.
    expect(mockLegacyClose).toHaveBeenCalledTimes(1);
    expect(mockCloseDatabaseConnection).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(processExitSpy).not.toHaveBeenCalled();

    process.exitCode = previousExitCode;
    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });
});
