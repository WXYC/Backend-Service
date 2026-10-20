import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPutMetricDataCommand = jest.fn().mockImplementation((input: unknown) => ({ input }));
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutMetricDataCommand: mockPutMetricDataCommand,
}));
jest.mock('@sentry/node', () => ({ init: jest.fn(), setTag: jest.fn(), close: jest.fn(), flush: jest.fn() }));

import { createJobLogger, HEARTBEAT_PUBLISH_TIMEOUT_MS } from '@wxyc/observability/job-logger';

import { expectPending, heldPromise } from '../../utils/held-promise';

describe('createJobLogger().withHeartbeat', () => {
  const original = process.env.CRON_HEARTBEAT_METRICS_DISABLED;
  beforeEach(() => {
    mockSend.mockReset().mockResolvedValue({});
    mockPutMetricDataCommand.mockClear();
    delete process.env.CRON_HEARTBEAT_METRICS_DISABLED;
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env.CRON_HEARTBEAT_METRICS_DISABLED;
    } else {
      process.env.CRON_HEARTBEAT_METRICS_DISABLED = original;
    }
  });

  it('sends HeartbeatSuccess for the job, and does not resolve until CloudWatch has accepted it', async () => {
    const send = heldPromise();
    mockSend.mockImplementation(send.hold);
    const { withHeartbeat } = createJobLogger({ jobName: 'demo-job' });
    const run = withHeartbeat(() => Promise.resolve(42));
    await expectPending(run);

    expect(mockSend).toHaveBeenCalledTimes(1);
    send.release({});
    await expect(run).resolves.toBe(42);
    const input = mockPutMetricDataCommand.mock.calls[0][0] as {
      Namespace: string;
      MetricData: Array<{ MetricName: string; Value: number; Dimensions: unknown }>;
    };
    expect(input.Namespace).toBe('WXYC/Cron');
    expect(input.MetricData).toEqual([
      expect.objectContaining({
        MetricName: 'HeartbeatSuccess',
        Value: 1,
        Dimensions: [{ Name: 'job', Value: 'demo-job' }],
      }),
    ]);
  });

  it('sends nothing and rethrows when the callback fails', async () => {
    const { withHeartbeat } = createJobLogger({ jobName: 'demo-job' });
    await expect(withHeartbeat(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends nothing when CRON_HEARTBEAT_METRICS_DISABLED is set', async () => {
    process.env.CRON_HEARTBEAT_METRICS_DISABLED = 'true';
    const { withHeartbeat } = createJobLogger({ jobName: 'demo-job' });
    await expect(withHeartbeat(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not fail the job when the publish fails', async () => {
    mockSend.mockRejectedValue(new Error('throttled'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { withHeartbeat } = createJobLogger({ jobName: 'demo-job' });
    await expect(withHeartbeat(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('aborts a stalled publish after the timeout, logs it, and still returns the result', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      mockSend.mockImplementation(
        (_command: unknown, options: unknown) =>
          new Promise((_resolve, reject) => {
            (options as { abortSignal: AbortSignal }).abortSignal.addEventListener('abort', () =>
              reject(new Error('aborted'))
            );
          })
      );
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const { withHeartbeat } = createJobLogger({ jobName: 'demo-job' });
      const run = withHeartbeat(() => Promise.resolve('ok'));
      await expectPending(run);
      expect(mockSend).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(HEARTBEAT_PUBLISH_TIMEOUT_MS);
      await expect(run).resolves.toBe('ok');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });
});
