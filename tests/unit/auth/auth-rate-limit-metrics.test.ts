/**
 * Auth-specific wiring for the BS#2169 GET /auth/get-session rate limiters:
 * namespace, metric name, dimension set, KeyKind classification, the
 * AUTH_RATE_LIMIT_METRICS_DISABLED short-circuit, the Sentry breadcrumb, and
 * the response body/status the custom `handler` sends. Generic emitter
 * mechanics (buffering, coalescing, flush timing, swallow-on-failure) are
 * covered separately by tests/unit/observability/metrics.test.ts.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { Request, Response } from 'express';
import type { Options } from 'express-rate-limit';

const mockSend = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockPutMetricDataCommand = jest.fn().mockImplementation((input: unknown) => ({ input }));
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  PutMetricDataCommand: mockPutMetricDataCommand,
}));

const mockAddBreadcrumb = jest.fn();
jest.mock('@sentry/node', () => ({
  addBreadcrumb: (...args: unknown[]) => mockAddBreadcrumb(...args),
}));

import { makeHandler, __resetForTests, __flushForTests } from '../../../apps/auth/auth-rate-limit-metrics';

type Handler = ReturnType<typeof makeHandler>;

function makeReq(overrides: {
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
}): Parameters<Handler>[0] {
  return {
    headers: overrides.headers ?? {},
    socket: { remoteAddress: overrides.remoteAddress },
  } as unknown as Request;
}

function makeRes(init: { headersSent?: boolean; writableEnded?: boolean } = {}) {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    headersSent: init.headersSent ?? false,
    writableEnded: init.writableEnded ?? false,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & {
    statusCode: number;
    body: unknown;
    headers: Record<string, string>;
  };
}

const rateLimitOptions = {
  statusCode: 429,
  windowMs: 60_000,
  message: { error: 'Too many requests, please try again later.' },
} as Options;

interface CapturedCommand {
  Namespace: string;
  MetricData: Array<{
    MetricName: string;
    Value: number;
    Dimensions: Array<{ Name: string; Value: string }>;
  }>;
}

function lastCommand(): CapturedCommand {
  const calls = mockPutMetricDataCommand.mock.calls;
  return calls[calls.length - 1][0] as CapturedCommand;
}

function dimensionMap(datum: CapturedCommand['MetricData'][number]): Record<string, string> {
  return Object.fromEntries(datum.Dimensions.map((d) => [d.Name, d.Value]));
}

describe('auth-rate-limit-metrics', () => {
  const originalDisabled = process.env.AUTH_RATE_LIMIT_METRICS_DISABLED;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockPutMetricDataCommand.mockClear();
    mockAddBreadcrumb.mockClear();
    delete process.env.AUTH_RATE_LIMIT_METRICS_DISABLED;
    __resetForTests();
  });

  afterEach(() => {
    if (originalDisabled === undefined) {
      delete process.env.AUTH_RATE_LIMIT_METRICS_DISABLED;
    } else {
      process.env.AUTH_RATE_LIMIT_METRICS_DISABLED = originalDisabled;
    }
    __resetForTests();
  });

  it('emits WXYC/AuthService RateLimited dimensioned by Limiter/KeyKind/Route, with no dimensionless companion', async () => {
    const handler = makeHandler('identity');
    const req = makeReq({ headers: { cookie: '__Secure-better-auth.session_token=abc123' } });
    const res = makeRes();

    handler(req, res, jest.fn(), rateLimitOptions);
    await __flushForTests();

    expect(mockPutMetricDataCommand).toHaveBeenCalledTimes(1);
    const call = lastCommand();
    expect(call.Namespace).toBe('WXYC/AuthService');
    // Dimensioned-only until the wxyc-canary alarm lands (see the module's
    // docstring) — exactly one datum, no empty-Dimensions companion.
    expect(call.MetricData).toHaveLength(1);

    const [datum] = call.MetricData;
    expect(datum.MetricName).toBe('RateLimited');
    expect(datum.Dimensions).toHaveLength(3);
    expect(dimensionMap(datum)).toEqual({
      Limiter: 'identity',
      KeyKind: 'session',
      Route: '/auth/get-session',
    });
  });

  it('classifies KeyKind as bearer when Authorization: Bearer is present, even on the ip limiter', async () => {
    const handler = makeHandler('ip');
    const req = makeReq({ headers: { authorization: 'Bearer sometoken' } });
    const res = makeRes();

    handler(req, res, jest.fn(), rateLimitOptions);
    await __flushForTests();

    const [datum] = lastCommand().MetricData;
    expect(dimensionMap(datum)).toEqual({ Limiter: 'ip', KeyKind: 'bearer', Route: '/auth/get-session' });
  });

  it('classifies KeyKind as ip when neither a session cookie nor a bearer token is present', async () => {
    const handler = makeHandler('ip');
    const req = makeReq({ headers: { 'x-real-ip': '203.0.113.7' } });
    const res = makeRes();

    handler(req, res, jest.fn(), rateLimitOptions);
    await __flushForTests();

    const [datum] = lastCommand().MetricData;
    expect(dimensionMap(datum).KeyKind).toBe('ip');
  });

  it('adds a Sentry breadcrumb, not a captured exception or message', () => {
    const handler = makeHandler('identity');
    const req = makeReq({ headers: {} });
    const res = makeRes();

    handler(req, res, jest.fn(), rateLimitOptions);

    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1);
    const [breadcrumb] = mockAddBreadcrumb.mock.calls[0] as [{ category: string; level: string }];
    expect(breadcrumb.category).toBe('auth.ratelimit');
    expect(breadcrumb.level).toBe('warning');
  });

  it('sends the shared 429 body shape via res.status(...).json(...)', () => {
    const handler = makeHandler('identity');
    const req = makeReq({ headers: {} });
    const res = makeRes();

    handler(req, res, jest.fn(), rateLimitOptions);

    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({ error: 'Too many requests, please try again later.' });
  });

  it.each([['ip'], ['identity']] as const)(
    'sets Retry-After from windowMs on a %s-limiter rejection, so both limiters back off identically',
    (limiter) => {
      // The abuse ceiling runs with standardHeaders:false, which also
      // suppresses express-rate-limit's own Retry-After. Without setting it
      // here, a client doing Retry-After backoff would back off correctly on a
      // fairness rejection and hot-loop against the ceiling.
      const handler = makeHandler(limiter);
      const res = makeRes();

      handler(makeReq({ headers: {} }), res, jest.fn(), rateLimitOptions);

      expect(res.headers['Retry-After']).toBe('60');
    }
  );

  it('does not set Retry-After once headers are already sent', () => {
    const handler = makeHandler('ip');
    const res = makeRes({ headersSent: true });

    handler(makeReq({ headers: {} }), res, jest.fn(), rateLimitOptions);

    expect(res.headers['Retry-After']).toBeUndefined();
  });

  it('does not write a body when the response has already ended', () => {
    // Mirrors express-rate-limit's own default-handler guard; without it this
    // becomes ERR_HTTP_HEADERS_SENT rather than a silent no-op.
    const handler = makeHandler('identity');
    const res = makeRes({ writableEnded: true });

    handler(makeReq({ headers: {} }), res, jest.fn(), rateLimitOptions);

    expect(res.body).toBeUndefined();
    expect(res.statusCode).toBe(0);
  });

  it('does not call PutMetricData when AUTH_RATE_LIMIT_METRICS_DISABLED=true', async () => {
    process.env.AUTH_RATE_LIMIT_METRICS_DISABLED = 'true';
    const handler = makeHandler('identity');
    const req = makeReq({ headers: {} });
    const res = makeRes();

    handler(req, res, jest.fn(), rateLimitOptions);
    await __flushForTests();

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('still sends the 429 response and breadcrumb when metrics are disabled', () => {
    process.env.AUTH_RATE_LIMIT_METRICS_DISABLED = 'true';
    const handler = makeHandler('ip');
    const req = makeReq({ headers: {} });
    const res = makeRes();

    handler(req, res, jest.fn(), rateLimitOptions);

    expect(res.statusCode).toBe(429);
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1);
  });
});
