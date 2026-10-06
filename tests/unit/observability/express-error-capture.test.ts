import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const mockCaptureException = jest.fn();
jest.mock('@sentry/core', () => ({
  ...jest.requireActual<object>('@sentry/core'),
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { sentryExpressErrorCapture } from '@wxyc/observability';

const req = { method: 'POST', url: '/flowsheet' } as Request;
const res = {} as Response;

describe('sentryExpressErrorCapture (BS#2947)', () => {
  it.each([
    ['captures when the predicate accepts', true, 1],
    ['skips the capture when the predicate rejects', false, 0],
  ])('%s', (_label, verdict, captures) => {
    const next = jest.fn() as NextFunction;
    const error = new Error('boom');

    sentryExpressErrorCapture(() => verdict)(error, req, res, next);

    expect(mockCaptureException).toHaveBeenCalledTimes(captures);
    expect(next).toHaveBeenCalledWith(error);
  });

  it('tags the capture with the mechanism the Sentry 10 handler used, so issue grouping is unchanged', () => {
    const error = new Error('boom');

    sentryExpressErrorCapture(() => true)(error, req, res, jest.fn());

    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      mechanism: { type: 'auto.middleware.express', handled: false },
    });
  });

  it.each([
    ['a string', 'bare string'],
    ['a plain object', { status: 404, expose: true }],
    ['undefined', undefined],
  ])('hands %s to the predicate raw and forwards it unchanged', (_label, thrown) => {
    const predicate = jest.fn(() => true);
    const next = jest.fn() as NextFunction;

    sentryExpressErrorCapture(predicate)(thrown, req, res, next);

    expect(predicate).toHaveBeenCalledWith(thrown);
    expect(mockCaptureException).toHaveBeenCalledWith(thrown, expect.anything());
    expect(next).toHaveBeenCalledWith(thrown);
  });

  it('declares four parameters so Express registers it as an error handler', () => {
    expect(sentryExpressErrorCapture(() => true).length).toBe(4);
  });
});
