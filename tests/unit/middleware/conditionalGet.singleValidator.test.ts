/**
 * BS#1689: watermarked flowsheet routes must carry exactly one freshness
 * validator (`conditionalGet`'s `Last-Modified`). Express's own default
 * weak per-body `ETag` is a second, independent validator — a client that
 * has cached both can revalidate against the ETag alone and get a 304 that
 * never passed through `conditionalGet`'s watermark check, which is how an
 * unspliced empty-body 304 reached the dj-site frontend (dj-site#983/#982).
 *
 * These tests exercise `singleValidatorCache` against a real Express app (not
 * a mocked `res`) because the bug and the fix both live inside Express's own
 * `res.send`/`res.json` internals (ETag generation happens synchronously
 * before `res.end` flushes headers) — a mocked response object can't
 * reproduce that ordering.
 */
import express from 'express';
import request from 'supertest';

import { singleValidatorCache } from '../../../apps/backend/middleware/conditionalGet.js';

describe('singleValidatorCache middleware', () => {
  const buildApp = () => {
    const app = express();
    app.get('/watermarked', singleValidatorCache, (_req, res) => {
      res.status(200).json({ hello: 'world' });
    });
    app.get('/unwrapped', (_req, res) => {
      res.status(200).json({ hello: 'world' });
    });
    return app;
  };

  it('sends no ETag header on a watermarked route', async () => {
    const res = await request(buildApp()).get('/watermarked');

    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeUndefined();
  });

  it('sends Cache-Control: no-cache on a watermarked route', async () => {
    const res = await request(buildApp()).get('/watermarked');

    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('still delivers the response body untouched', async () => {
    const res = await request(buildApp()).get('/watermarked');

    expect(res.body).toEqual({ hello: 'world' });
  });

  // Control case: without the middleware, Express's default weak ETag is
  // present — confirms the test would fail without the fix, i.e. the
  // suppression is doing real work rather than Express never emitting one.
  it('control: the unwrapped route still gets Express default ETag', async () => {
    const res = await request(buildApp()).get('/unwrapped');

    expect(res.headers.etag).toBeDefined();
  });
});
