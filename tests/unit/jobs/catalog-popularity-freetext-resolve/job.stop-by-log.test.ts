/**
 * Pins the BS#1814 stop-reason log line (`stop_by_reached` vs
 * `backlog_drained`) — a separate file that mocks the job's local logger
 * module so `log()` calls are observable, mirroring the established
 * isolation pattern in
 * tests/unit/jobs/concerts-poster-enrichment/orchestrate.capture.test.ts (a
 * separate file so the logger mock can't leak into job.test.ts, which relies
 * on the real no-op logger — `log()` silently no-ops there because
 * `initLogger()` is never called in the unit suite).
 */
import { jest } from '@jest/globals';

const mockBulkLookupMetadata = jest.fn<(items: unknown, opts?: unknown) => Promise<unknown>>();
jest.mock('@wxyc/lml-client', () => ({
  __esModule: true,
  bulkLookupMetadata: mockBulkLookupMetadata,
}));

jest.mock('@sentry/node', () => ({
  __esModule: true,
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  init: jest.fn(),
  setTag: jest.fn(),
  captureException: jest.fn(),
  close: jest.fn(() => Promise.resolve(true)),
}));

const mockLog = jest.fn();
jest.mock('../../../../jobs/catalog-popularity-freetext-resolve/logger', () => ({
  __esModule: true,
  log: mockLog,
  captureError: jest.fn(),
  initLogger: jest.fn(() => 'run-id'),
  closeLogger: jest.fn(() => Promise.resolve()),
}));

import { db } from '@wxyc/database';
import { runResolve, type ResolveOptions } from '../../../../jobs/catalog-popularity-freetext-resolve/job';

const baseOptions = (over: Partial<ResolveOptions> = {}): ResolveOptions => ({
  batchSize: 5,
  ratePerMin: 600,
  budgetMs: 25000,
  noMatchTtlDays: 30,
  maxPairsPerRun: 0,
  readTimeoutMs: 300_000,
  liveActivityLookbackSeconds: 0,
  liveActivityPauseMs: 1,
  stopByUtc: '23:59',
  now: () => Date.UTC(2026, 0, 1, 0, 0, 0),
  dryRun: false,
  ...over,
});

const stepsLogged = (): string[] => mockLog.mock.calls.map((call) => call[1] as string);

describe('runResolve — stop-reason log line (BS#1814)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs stop_by_reached (and does NOT log backlog_drained) when the deadline has already passed at startup', async () => {
    const now = jest.fn<() => number>().mockReturnValue(Date.UTC(2026, 6, 25, 20, 0, 0));

    await runResolve(baseOptions({ stopByUtc: '11:00', now }));

    expect(stepsLogged()).toContain('stop_by_reached');
    expect(stepsLogged()).not.toContain('backlog_drained');
  });

  it('logs stop_by_reached (and does NOT log backlog_drained) when the deadline is reached mid-run', async () => {
    const mock = db.execute as jest.Mock;
    mock
      .mockResolvedValueOnce({}) // SET LOCAL
      .mockResolvedValueOnce([
        { artist_name: 'A', album_title: 'X' },
        { artist_name: 'B', album_title: 'Y' },
      ])
      .mockResolvedValueOnce([]); // loadSkipKeys

    mockBulkLookupMetadata.mockResolvedValueOnce({
      results: [{ index: 0, status: 'no_match', lookup: { results: [] } }],
    });

    const T_START = Date.UTC(2026, 6, 25, 4, 45, 0);
    const T_PAST = Date.UTC(2026, 6, 25, 12, 0, 1);
    const now = jest
      .fn<() => number>()
      .mockReturnValueOnce(T_START) // initial deadline computation
      .mockReturnValueOnce(T_START) // startup no-op check
      .mockReturnValueOnce(T_START) // batch 0's pre-pause check
      .mockReturnValueOnce(T_START) // batch 0's post-pause check
      .mockReturnValue(T_PAST); // batch 1's pre-pause check onward: past the deadline

    await runResolve(baseOptions({ batchSize: 1, stopByUtc: '12:00', now }));

    expect(stepsLogged()).toContain('stop_by_reached');
    expect(stepsLogged()).not.toContain('backlog_drained');
  });

  it('logs backlog_drained (and does NOT log stop_by_reached) when the run completes before the deadline', async () => {
    const mock = db.execute as jest.Mock;
    mock
      .mockResolvedValueOnce({}) // SET LOCAL
      .mockResolvedValueOnce([{ artist_name: 'J Dilla', album_title: 'Donuts' }])
      .mockResolvedValueOnce([]); // loadSkipKeys

    mockBulkLookupMetadata.mockResolvedValue({
      results: [{ index: 0, status: 'no_match', lookup: { results: [] } }],
    });

    await runResolve(baseOptions());

    expect(stepsLogged()).toContain('backlog_drained');
    expect(stepsLogged()).not.toContain('stop_by_reached');
  });
});
