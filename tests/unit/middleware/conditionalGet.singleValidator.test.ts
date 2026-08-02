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

  // BS#1800: the dj-site#983 regression this middleware exists to prevent.
  // Before #1689, a watermarked route carried two independent freshness
  // validators — this middleware's `Last-Modified` and Express's own
  // body-hash `ETag`. A client that had cached the body-hash ETag from an
  // earlier response could echo it back as `If-None-Match`; Express's
  // internal `res.send` freshness check matched it and converted the
  // response to an empty-body 304 without ever going through
  // `conditionalGet`'s watermark decision. This test captures the ETag
  // Express's default weak-etag generator assigns to this exact body (via
  // the sibling `/unwrapped` route, which renders identical content without
  // `singleValidatorCache`) and echoes it back as `If-None-Match` on the
  // watermarked route. If a future change re-enables a body-hash ETag on a
  // watermarked route, this captured value WOULD match it and this test
  // would fail with a 304 + empty body — exactly reproducing the bug.
  it('returns 200 + full body on If-None-Match, not an Express-internal empty-body 304 (dj-site#983 regression)', async () => {
    const app = buildApp();

    const control = await request(app).get('/unwrapped');
    const bodyHashEtag = control.headers.etag;
    expect(bodyHashEtag).toBeDefined();

    const res = await request(app).get('/watermarked').set('If-None-Match', bodyHashEtag);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hello: 'world' });
  });

  // BS#1800 sentinel hardening. The suppression sentinel written to `ETag`
  // before the route handler runs used to be the fixed literal
  // `wxyc-no-etag`. It is stripped before the response flushes, so a
  // conforming client can never legitimately have cached it — but if a
  // client (buggy, stale, or probing) echoed that exact literal back as
  // `If-None-Match`, Express's internal freshness check would match it and
  // produce the same empty-body 304 bypass, skipping `conditionalGet`
  // entirely. The sentinel is now randomized per process, so the old
  // literal must no longer match.
  it('does not bypass on the literal legacy sentinel value "wxyc-no-etag"', async () => {
    const res = await request(buildApp()).get('/watermarked').set('If-None-Match', 'wxyc-no-etag');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hello: 'world' });
  });
});
