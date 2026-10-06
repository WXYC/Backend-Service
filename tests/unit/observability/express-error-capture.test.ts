import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import { sentryExpressErrorCapture } from '@wxyc/observability';

const req = { method: 'POST', url: '/flowsheet' } as Request;
const res = {} as Response;

function makeCapture(shouldCapture: (error: unknown) => boolean) {
  const captureException = jest.fn();
  return { captureException, middleware: sentryExpressErrorCapture({ shouldCapture, captureException }) };
}

describe('sentryExpressErrorCapture (BS#2947)', () => {
  it.each([
    ['captures when the predicate accepts', true, 1],
    ['skips the capture when the predicate rejects', false, 0],
  ])('%s', (_label, verdict, captures) => {
    const { captureException, middleware } = makeCapture(() => verdict);
    const next = jest.fn() as NextFunction;
    const error = new Error('boom');

    middleware(error, req, res, next);

    expect(captureException).toHaveBeenCalledTimes(captures);
    expect(next).toHaveBeenCalledWith(error);
  });

  it('tags the capture with the mechanism the Sentry 10 handler used, so issue grouping is unchanged', () => {
    const { captureException, middleware } = makeCapture(() => true);
    const error = new Error('boom');

    middleware(error, req, res, jest.fn());

    expect(captureException).toHaveBeenCalledWith(error, {
      mechanism: { type: 'auto.middleware.express', handled: false },
    });
  });

  it.each([
    ['a string', 'bare string'],
    ['a plain object', { status: 404, expose: true }],
    ['null', null],
  ])('hands %s to the predicate raw and forwards it unchanged', (_label, thrown) => {
    const predicate = jest.fn(() => true);
    const { captureException, middleware } = makeCapture(predicate);
    const next = jest.fn() as NextFunction;

    middleware(thrown, req, res, next);

    expect(predicate).toHaveBeenCalledWith(thrown);
    expect(captureException).toHaveBeenCalledWith(thrown, expect.anything());
    expect(next).toHaveBeenCalledWith(thrown);
  });

  it('captures and forwards the ORIGINAL error when the predicate itself throws', () => {
    const { captureException, middleware } = makeCapture(() => {
      throw new TypeError('predicate bug');
    });
    const next = jest.fn() as NextFunction;
    const error = new Error('original');

    middleware(error, req, res, next);

    expect(captureException).toHaveBeenCalledWith(error, expect.anything());
    expect(next).toHaveBeenCalledWith(error);
  });

  it('declares four parameters so Express registers it as an error handler', () => {
    expect(makeCapture(() => true).middleware.length).toBe(4);
  });

  describe('in a real Express pipeline', () => {
    class ExpectedError extends Error {}

    function buildApp() {
      const { captureException, middleware } = makeCapture((e) => !(e instanceof ExpectedError));
      const app = express();
      app.get('/expected', () => {
        throw new ExpectedError('handled upstream');
      });
      app.get('/boom', () => {
        throw new Error('genuine 500');
      });
      // An intermediate handler that answers the error itself: Sentry 10 never
      // saw these, and neither must the terminal capture.
      app.get(
        '/swallowed',
        () => {
          throw new Error('swallowed');
        },
        (_err: unknown, _q: Request, r: Response, _n: NextFunction) => {
          r.status(503).end();
        }
      );
      app.use(middleware);
      app.use((err: Error, _q: Request, r: Response, _n: NextFunction) => {
        r.status(500).json({ message: err.message });
      });
      return { app, captureException };
    }

    it.each([
      ['/boom', 500, 1],
      ['/expected', 500, 0],
      ['/swallowed', 503, 0],
    ])('GET %s answers %i and captures %i time(s)', async (path, status, captures) => {
      const { app, captureException } = buildApp();

      const response = await request(app).get(path);

      expect(response.status).toBe(status);
      expect(captureException).toHaveBeenCalledTimes(captures);
    });

    it('still lets the terminal handler render the original error', async () => {
      const { app } = buildApp();

      const response = await request(app).get('/boom');

      expect(response.body).toEqual({ message: 'genuine 500' });
    });
  });
});
