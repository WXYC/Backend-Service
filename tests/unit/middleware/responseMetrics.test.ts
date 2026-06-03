import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import type { Request, Response, NextFunction } from 'express';

// Mock @aws-sdk/client-cloudwatch so the middleware never tries to talk to AWS.
const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPutMetricDataCommand = jest.fn().mockImplementation((input: unknown) => ({ input }));
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  PutMetricDataCommand: mockPutMetricDataCommand,
}));

import {
  responseMetricsMiddleware,
  classifyRoute,
  __resetForTests,
  __flushForTests,
} from '../../../apps/backend/middleware/responseMetrics';

interface MockResponse extends EventEmitter {
  statusCode: number;
}

function makeReq(method: string, originalUrl: string): Request {
  return { method, originalUrl } as unknown as Request;
}

function makeRes(statusCode: number): MockResponse {
  const res = new EventEmitter() as MockResponse;
  res.statusCode = statusCode;
  return res;
}

describe('responseMetricsMiddleware', () => {
  let next: jest.Mock<NextFunction>;
  const originalDisabled = process.env.MUTATION_4XX_METRICS_DISABLED;

  beforeEach(() => {
    next = jest.fn();
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockPutMetricDataCommand.mockClear();
    delete process.env.MUTATION_4XX_METRICS_DISABLED;
    __resetForTests();
  });

  afterEach(() => {
    if (originalDisabled === undefined) {
      delete process.env.MUTATION_4XX_METRICS_DISABLED;
    } else {
      process.env.MUTATION_4XX_METRICS_DISABLED = originalDisabled;
    }
    __resetForTests();
  });

  it('emits a metric on a 403 POST /flowsheet/ with correct dimensions', async () => {
    const req = makeReq('POST', '/flowsheet/');
    const res = makeRes(403);

    responseMetricsMiddleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();

    res.emit('finish');
    await __flushForTests();

    expect(mockPutMetricDataCommand).toHaveBeenCalledTimes(1);
    const call = mockPutMetricDataCommand.mock.calls[0][0] as {
      Namespace: string;
      MetricData: Array<{
        MetricName: string;
        Unit: string;
        Value: number;
        Dimensions: Array<{ Name: string; Value: string }>;
      }>;
    };
    expect(call.Namespace).toBe('WXYC/BackendService');
    // Emit-twice convention: one dimensioned datum (dashboards / per-route
    // drill-down) plus one dimensionless companion (the series the canary's
    // plain-form Namespace/MetricName alarm queries). See wxyc-canary#13 for
    // the post-mortem that drove this pattern.
    expect(call.MetricData).toHaveLength(2);
    const dimensioned = call.MetricData.filter((datum) => datum.Dimensions.length > 0);
    const dimensionless = call.MetricData.filter((datum) => datum.Dimensions.length === 0);
    expect(dimensioned).toHaveLength(1);
    expect(dimensionless).toHaveLength(1);
    expect(dimensioned[0].MetricName).toBe('MutationClientError');
    expect(dimensioned[0].Unit).toBe('Count');
    expect(dimensioned[0].Value).toBe(1);
    expect(dimensioned[0].Dimensions).toEqual(
      expect.arrayContaining([
        { Name: 'Route', Value: 'POST /flowsheet/' },
        { Name: 'StatusCode', Value: '403' },
      ])
    );
    expect(dimensionless[0].MetricName).toBe('MutationClientError');
    expect(dimensionless[0].Unit).toBe('Count');
    expect(dimensionless[0].Value).toBe(1);
    expect(dimensionless[0].Dimensions).toEqual([]);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('does not emit a metric on a 200 POST /flowsheet/', async () => {
    const req = makeReq('POST', '/flowsheet/');
    const res = makeRes(200);

    responseMetricsMiddleware(req, res as unknown as Response, next);
    res.emit('finish');
    await __flushForTests();

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPutMetricDataCommand).not.toHaveBeenCalled();
  });

  it('does not emit a metric on a 403 GET /library/release/123 (read path, out of scope)', async () => {
    const req = makeReq('GET', '/library/release/123');
    const res = makeRes(403);

    responseMetricsMiddleware(req, res as unknown as Response, next);
    res.emit('finish');
    await __flushForTests();

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPutMetricDataCommand).not.toHaveBeenCalled();
  });

  it('does not emit a metric on a 404 POST /djs/foo (mutation method but non-flowsheet path)', async () => {
    const req = makeReq('POST', '/djs/foo');
    const res = makeRes(404);

    responseMetricsMiddleware(req, res as unknown as Response, next);
    res.emit('finish');
    await __flushForTests();

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not emit when MUTATION_4XX_METRICS_DISABLED=true', async () => {
    process.env.MUTATION_4XX_METRICS_DISABLED = 'true';

    const req = makeReq('POST', '/flowsheet/');
    const res = makeRes(403);

    responseMetricsMiddleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();

    res.emit('finish');
    await __flushForTests();

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPutMetricDataCommand).not.toHaveBeenCalled();
  });

  it('completes the response successfully even when PutMetricData throws', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSend.mockRejectedValue(new Error('CloudWatch unreachable'));

    const req = makeReq('PATCH', '/flowsheet/play-order');
    const res = makeRes(409);

    responseMetricsMiddleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalled();

    // The request still finishes normally — emitting 'finish' must not throw
    // and must not block.
    expect(() => res.emit('finish')).not.toThrow();
    await __flushForTests();

    expect(mockSend).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[responseMetrics] PutMetricData failed; dropping batch:',
      expect.any(Error)
    );

    consoleErrorSpy.mockRestore();
  });

  it('coalesces identical (route, statusCode) into one MetricDatum with summed Count', async () => {
    // Hammer the same endpoint with three 403s on POST /flowsheet/.
    for (let i = 0; i < 3; i += 1) {
      const req = makeReq('POST', '/flowsheet/');
      const res = makeRes(403);
      responseMetricsMiddleware(req, res as unknown as Response, next);
      res.emit('finish');
    }
    await __flushForTests();

    expect(mockPutMetricDataCommand).toHaveBeenCalledTimes(1);
    const call = mockPutMetricDataCommand.mock.calls[0][0] as {
      MetricData: Array<{ Value: number; Dimensions: Array<{ Name: string; Value: string }> }>;
    };
    // One coalesced (POST /flowsheet/, 403) entry surfaces as two datapoints
    // under the emit-twice convention: dimensioned + dimensionless companion.
    expect(call.MetricData).toHaveLength(2);
    expect(call.MetricData.every((datum) => datum.Value === 3)).toBe(true);
  });

  it('flushes automatically when the buffer hits 10 errors', async () => {
    // Fire 10 distinct 4xx mutation responses. The 10th should trigger an
    // immediate flush without waiting for the 30s timer.
    for (let i = 0; i < 10; i += 1) {
      const req = makeReq('DELETE', '/flowsheet/');
      const res = makeRes(409);
      responseMetricsMiddleware(req, res as unknown as Response, next);
      res.emit('finish');
    }

    // Yield once for the synchronous flush kicked off in recordError.
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSend).toHaveBeenCalledTimes(1);
    const call = mockPutMetricDataCommand.mock.calls[0][0] as {
      MetricData: Array<{ Value: number; Dimensions: Array<{ Name: string; Value: string }> }>;
    };
    expect(call.MetricData).toHaveLength(2);
    expect(call.MetricData.every((datum) => datum.Value === 10)).toBe(true);
  });

  it('emits N dimensioned + N dimensionless entries when the buffer holds distinct (route, statusCode) pairs', async () => {
    // Mix two distinct coalescence keys in one flush. Expect a dimensioned and
    // dimensionless datapoint per key, with matching Values across the pair.
    const cases: Array<{ method: 'POST' | 'PATCH'; url: string; status: number }> = [
      { method: 'POST', url: '/flowsheet/', status: 403 },
      { method: 'POST', url: '/flowsheet/', status: 403 },
      { method: 'PATCH', url: '/flowsheet/play-order', status: 409 },
    ];
    for (const c of cases) {
      const req = makeReq(c.method, c.url);
      const res = makeRes(c.status);
      responseMetricsMiddleware(req, res as unknown as Response, next);
      res.emit('finish');
    }
    await __flushForTests();

    expect(mockPutMetricDataCommand).toHaveBeenCalledTimes(1);
    const call = mockPutMetricDataCommand.mock.calls[0][0] as {
      MetricData: Array<{
        MetricName: string;
        Value: number;
        Dimensions: Array<{ Name: string; Value: string }>;
      }>;
    };
    // Two distinct (route, statusCode) pairs => 2 dimensioned + 2 dimensionless = 4 total.
    expect(call.MetricData).toHaveLength(4);
    const dimensioned = call.MetricData.filter((datum) => datum.Dimensions.length > 0);
    const dimensionless = call.MetricData.filter((datum) => datum.Dimensions.length === 0);
    expect(dimensioned).toHaveLength(2);
    expect(dimensionless).toHaveLength(2);
    // Per-key value parity: each dimensioned entry has a partner dimensionless
    // entry with the same Value, so Statistic: Sum returns identical totals
    // when sliced or not. The (POST /flowsheet/, 403) key has Value 2, the
    // (PATCH /flowsheet/play-order, 409) key has Value 1.
    const dimensionedValues = [...dimensioned.map((d) => d.Value)].sort();
    const dimensionlessValues = [...dimensionless.map((d) => d.Value)].sort();
    expect(dimensionedValues).toEqual([1, 2]);
    expect(dimensionlessValues).toEqual([1, 2]);
  });
});

describe('classifyRoute', () => {
  it('returns POST /flowsheet/ for the bare flowsheet root', () => {
    expect(classifyRoute('POST', '/flowsheet/')).toBe('POST /flowsheet/');
  });

  it('returns the first sub-segment for nested mutation routes', () => {
    expect(classifyRoute('PATCH', '/flowsheet/play-order')).toBe('PATCH /flowsheet/play-order');
    expect(classifyRoute('POST', '/flowsheet/join')).toBe('POST /flowsheet/join');
    expect(classifyRoute('POST', '/flowsheet/end')).toBe('POST /flowsheet/end');
  });

  it('strips query strings before classifying', () => {
    expect(classifyRoute('POST', '/flowsheet/?show_id=42')).toBe('POST /flowsheet/');
  });

  it('drops further nested segments to bound dimension cardinality', () => {
    expect(classifyRoute('POST', '/flowsheet/suggest/artists')).toBe('POST /flowsheet/suggest');
  });
});
