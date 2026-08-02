/**
 * Unit tests for orchestrate.run() -- the digest job's control-flow spine.
 * Every collaborator (query, format, email, watermark, logger, db) is mocked
 * so these tests pin ONLY the orchestration: the watermark advance/no-advance
 * decision per outcome (0-row, sent, send-failure, disabled dry-run), the
 * first-run window, and the truncation flag. Formatting / query SQL / SES
 * semantics have their own suites. No DB or network is touched.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockGetLastRun = jest.fn();
const mockResolveWindowStart = jest.fn();
const mockResolvePlayAgeCutoff = jest.fn();
const mockAdvanceWatermark = jest.fn();
jest.mock('../../../../jobs/metadata-no-match-digest/watermark', () => ({
  getLastRun: mockGetLastRun,
  resolveWindowStart: mockResolveWindowStart,
  resolvePlayAgeCutoff: mockResolvePlayAgeCutoff,
  advanceWatermarkIfSuccessful: mockAdvanceWatermark,
}));

const mockQueryNoMatchRows = jest.fn();
jest.mock('../../../../jobs/metadata-no-match-digest/query', () => ({
  MAX_DIGEST_ROWS: 3, // small cap so the truncation test needs only 3 rows
  queryNoMatchRows: mockQueryNoMatchRows,
}));

const mockBuildDigestEmail = jest.fn();
jest.mock('../../../../jobs/metadata-no-match-digest/format', () => ({
  buildDigestEmail: mockBuildDigestEmail,
}));

const mockSendDigestEmail = jest.fn();
const mockResolveDigestRecipient = jest.fn(() => 'jake@wxyc.org');
jest.mock('../../../../jobs/metadata-no-match-digest/email', () => ({
  sendDigestEmail: mockSendDigestEmail,
  resolveDigestRecipient: mockResolveDigestRecipient,
}));

jest.mock('../../../../jobs/metadata-no-match-digest/logger', () => ({
  log: jest.fn(),
  errorMessage: (e: unknown): string => (e instanceof Error ? e.message : JSON.stringify(e)),
}));

const mockDb = { __mock: 'db' };
jest.mock('@wxyc/database', () => ({ db: mockDb }));

import { run } from '../../../../jobs/metadata-no-match-digest/orchestrate';

const DIGEST = { subject: 's', html: '<p>h</p>', text: 't' };
const WINDOW_START = new Date('2026-07-30T15:07:00Z');
const PLAY_AGE_CUTOFF = new Date('2026-07-29T15:07:00Z');

describe('orchestrate.run()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLastRun.mockResolvedValue(new Date('2026-07-30T15:07:00Z') as never);
    mockResolveWindowStart.mockReturnValue(WINDOW_START);
    mockResolvePlayAgeCutoff.mockReturnValue(PLAY_AGE_CUTOFF);
    mockAdvanceWatermark.mockResolvedValue(true as never);
    mockResolveDigestRecipient.mockReturnValue('jake@wxyc.org');
  });

  it('advances the watermark and sends nothing when there are no misses', async () => {
    mockQueryNoMatchRows.mockResolvedValue([] as never);
    mockBuildDigestEmail.mockReturnValue(null);

    await run();

    expect(mockSendDigestEmail).not.toHaveBeenCalled();
    expect(mockAdvanceWatermark).toHaveBeenCalledTimes(1);
    expect(mockAdvanceWatermark).toHaveBeenCalledWith(mockDb, 'metadata-no-match-digest', expect.any(Date), true);
  });

  it('sends the digest and advances the watermark on a successful send', async () => {
    mockQueryNoMatchRows.mockResolvedValue([{ id: 1 }] as never);
    mockBuildDigestEmail.mockReturnValue(DIGEST);
    mockSendDigestEmail.mockResolvedValue(true as never);

    await run();

    expect(mockSendDigestEmail).toHaveBeenCalledTimes(1);
    expect(mockSendDigestEmail).toHaveBeenCalledWith('jake@wxyc.org', DIGEST);
    expect(mockAdvanceWatermark).toHaveBeenCalledWith(mockDb, 'metadata-no-match-digest', expect.any(Date), true);
  });

  it('does NOT advance the watermark and rethrows when the send fails', async () => {
    mockQueryNoMatchRows.mockResolvedValue([{ id: 1 }] as never);
    mockBuildDigestEmail.mockReturnValue(DIGEST);
    mockSendDigestEmail.mockRejectedValue(new Error('SES down') as never);

    await expect(run()).rejects.toThrow('SES down');
    expect(mockAdvanceWatermark).not.toHaveBeenCalled();
  });

  it('does NOT advance the watermark on a disabled observe-only run (sendDigestEmail returns false)', async () => {
    mockQueryNoMatchRows.mockResolvedValue([{ id: 1 }] as never);
    mockBuildDigestEmail.mockReturnValue(DIGEST);
    mockSendDigestEmail.mockResolvedValue(false as never);

    await run();

    expect(mockSendDigestEmail).toHaveBeenCalledTimes(1);
    expect(mockAdvanceWatermark).not.toHaveBeenCalled();
  });

  it('bounds the window via resolveWindowStart on the first run (no prior watermark)', async () => {
    mockGetLastRun.mockResolvedValue(null as never);
    mockQueryNoMatchRows.mockResolvedValue([] as never);
    mockBuildDigestEmail.mockReturnValue(null);

    await run();

    expect(mockResolveWindowStart).toHaveBeenCalledWith(null, expect.any(Date));
    expect(mockQueryNoMatchRows).toHaveBeenCalledWith(WINDOW_START, PLAY_AGE_CUTOFF);
  });

  it('passes truncated=true to the formatter when the query hits MAX_DIGEST_ROWS', async () => {
    mockQueryNoMatchRows.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }] as never); // length === MAX (3)
    mockBuildDigestEmail.mockReturnValue(DIGEST);
    mockSendDigestEmail.mockResolvedValue(true as never);

    await run();

    expect(mockBuildDigestEmail).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ truncated: true }));
  });

  it('passes truncated=false to the formatter below the row cap', async () => {
    mockQueryNoMatchRows.mockResolvedValue([{ id: 1 }] as never);
    mockBuildDigestEmail.mockReturnValue(DIGEST);
    mockSendDigestEmail.mockResolvedValue(true as never);

    await run();

    expect(mockBuildDigestEmail).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ truncated: false }));
  });
});
