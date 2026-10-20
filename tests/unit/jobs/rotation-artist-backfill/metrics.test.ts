import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

import type { BulkCacheRefreshResponse } from '@wxyc/lml-client';

import type { FetchOutcome } from '../../../../jobs/rotation-artist-backfill/lml-fetch';
import { expectPending, heldPromise } from '../../../utils/held-promise';

// BS#3401: the BS#1402 not_found / lml_error signals move off Sentry spans to
// two dimensionless CloudWatch counters in WXYC/RotationArtistBackfill. The
// data must be sent before runBackfill resolves, on success AND failure,
// because the job closes the logger (and exits) right after.

const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPutMetricDataCommand = jest.fn().mockImplementation((input: unknown) => ({ input }));
const mockCloudWatchClient = jest.fn().mockImplementation(() => ({ send: mockSend }));
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: mockCloudWatchClient,
  PutMetricDataCommand: mockPutMetricDataCommand,
}));

import { runBackfill } from '../../../../jobs/rotation-artist-backfill/orchestrate';

type PutCall = { Namespace: string; MetricData: Array<{ MetricName: string; Value: number; Dimensions?: unknown[] }> };
const putCalls = (): PutCall[] => mockPutMetricDataCommand.mock.calls.map((c) => c[0] as PutCall);

const okFetch = (value: BulkCacheRefreshResponse) =>
  jest
    .fn<(batch: number[]) => Promise<FetchOutcome<BulkCacheRefreshResponse>>>()
    .mockResolvedValue({ kind: 'ok', value });

describe('rotation-artist-backfill CloudWatch counters (BS#3401)', () => {
  const originalDisabled = process.env.ROTATION_ARTIST_BACKFILL_METRICS_DISABLED;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockPutMetricDataCommand.mockClear();
    mockCloudWatchClient.mockClear();
    delete process.env.ROTATION_ARTIST_BACKFILL_METRICS_DISABLED;
  });

  afterEach(() => {
    if (originalDisabled === undefined) delete process.env.ROTATION_ARTIST_BACKFILL_METRICS_DISABLED;
    else process.env.ROTATION_ARTIST_BACKFILL_METRICS_DISABLED = originalDisabled;
  });

  it('sends NotFound and LmlError, dimensionless, before runBackfill resolves on success', async () => {
    const send = heldPromise();
    mockSend.mockImplementation(send.hold);

    // An empty response is tallied as a batch error: 2 ids -> lml_error 2.
    const run = runBackfill({
      loadIdentityIds: jest.fn<() => Promise<number[]>>().mockResolvedValue([1, 2]),
      fetchFn: okFetch({} as BulkCacheRefreshResponse),
    });
    await expectPending(run);

    expect(mockSend).toHaveBeenCalledTimes(1);
    send.release({});
    await run;

    const [call] = putCalls();
    expect(call.Namespace).toBe('WXYC/RotationArtistBackfill');
    const byName = Object.fromEntries(call.MetricData.map((d) => [d.MetricName, d]));
    expect(byName.NotFound.Value).toBe(0);
    expect(byName.LmlError.Value).toBe(2);
    expect(call.MetricData).toHaveLength(2);
    for (const d of call.MetricData) expect(d.Dimensions ?? []).toEqual([]);
  });

  it('sends the counters before runBackfill rejects when the fan-out throws', async () => {
    const send = heldPromise();
    mockSend.mockImplementation(send.hold);
    const fetchFn = jest
      .fn<(batch: number[]) => Promise<FetchOutcome<BulkCacheRefreshResponse>>>()
      .mockRejectedValue(new Error('boom'));

    const run = runBackfill({
      loadIdentityIds: jest.fn<() => Promise<number[]>>().mockResolvedValue([1]),
      fetchFn,
    });
    await expectPending(run);

    expect(mockSend).toHaveBeenCalledTimes(1);
    send.release({});
    await expect(run).rejects.toThrow();
    expect(putCalls()[0].Namespace).toBe('WXYC/RotationArtistBackfill');
  });

  it('constructs no CloudWatch client when the opt-out is set', async () => {
    process.env.ROTATION_ARTIST_BACKFILL_METRICS_DISABLED = 'true';

    await runBackfill({
      loadIdentityIds: jest.fn<() => Promise<number[]>>().mockResolvedValue([1]),
      fetchFn: okFetch({} as BulkCacheRefreshResponse),
    });

    expect(mockCloudWatchClient).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
