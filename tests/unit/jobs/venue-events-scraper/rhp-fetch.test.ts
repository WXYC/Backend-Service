/**
 * Unit tests for the rhp-fetch helper module.
 *
 * `mapConcurrent`'s catch is the safety net for unexpected exceptions
 * thrown out of the per-event pipeline. The orchestrator's
 * `processOneEvent` is structured to never throw under normal operation
 * (every pipeline step is wrapped in try/catch and converted to a
 * tagged result), so anything that lands in this catch is by definition
 * a programming defect — we want it visible in the dashboards, not
 * silently swallowed by a `if (r === null) continue` filter upstream.
 */
import { mapConcurrent } from '../../../../jobs/venue-events-scraper/rhp-fetch';
import { initLogger, closeLogger } from '../../../../jobs/venue-events-scraper/logger';

describe('mapConcurrent', () => {
  beforeEach(() => {
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => jest.restoreAllMocks());

  it('returns an array aligned with input order', async () => {
    const out = await mapConcurrent([1, 2, 3], 2, (n) => Promise.resolve(n * 10));
    expect(out).toEqual([10, 20, 30]);
  });

  it('returns null in the slot of a task that resolves successfully but with null', async () => {
    const out = await mapConcurrent([1, 2, 3], 2, (n) => Promise.resolve(n === 2 ? null : n));
    expect(out).toEqual([1, null, 3]);
  });

  it('suppresses a single thrown error and leaves null in that slot', async () => {
    // Default beforeEach stdout spy is a no-op; logger.log is a no-op
    // when initLogger hasn't run. Sentry SDK silently no-ops without DSN.
    const out = await mapConcurrent([1, 2, 3], 2, (n) => {
      if (n === 2) return Promise.reject(new Error('boom'));
      return Promise.resolve(n * 10);
    });
    expect(out).toEqual([10, null, 30]);
  });

  it('logs + captures unexpected worker exceptions so they surface in dashboards', async () => {
    // Drives the safety-net path: the worker fn throws, mapConcurrent
    // catches, and we want to confirm the catch emits a log line on stderr
    // (the only observable side effect that doesn't require mocking Sentry).
    const writes: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    initLogger({ repo: 'Backend-Service', tool: 'venue-events-scraper-test' });
    try {
      await mapConcurrent([1, 2, 3], 2, (n) => {
        if (n === 2) return Promise.reject(new Error('unexpected programmer error'));
        return Promise.resolve(n);
      });
      const errorLines = writes
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((obj) => obj.step === 'unexpected_worker_error');
      expect(errorLines).toHaveLength(1);
      expect(errorLines[0]).toMatchObject({
        level: 'error',
        step: 'unexpected_worker_error',
        item_index: 1,
        error_message: 'unexpected programmer error',
      });
    } finally {
      await closeLogger();
    }
  });

  it('coerces concurrency < 1 to a single worker', async () => {
    const out = await mapConcurrent([1, 2, 3], 0, (n) => Promise.resolve(n));
    expect(out).toEqual([1, 2, 3]);
  });
});
