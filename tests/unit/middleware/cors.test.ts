import express from 'express';
import request from 'supertest';
import { buildCorsMiddleware } from '../../../apps/backend/middleware/cors';

// BS#2061. The pure branch logic is covered in
// tests/unit/authentication/cors-origin.test.ts; this suite asserts the actual
// response headers the `cors` package emits for each branch, because that is
// what a browser on wxyc.org sees and what the ticket's acceptance criteria are
// written against.

const DJ = 'https://dj.wxyc.org';
const PUBLIC = 'https://wxyc.org';

function appWith(env: NodeJS.ProcessEnv) {
  const app = express();
  app.use(buildCorsMiddleware(env));
  app.get('/flowsheet', (_req, res) => void res.json({ ok: true }));
  app.get('/flowsheet/range', (_req, res) => void res.json({ shows: [], entries: [] }));
  app.get('/flowsheet/search', (_req, res) => void res.json({ results: [] }));
  app.get('/library', (_req, res) => void res.json({ ok: true }));
  app.post('/flowsheet', (_req, res) => void res.json({ ok: true }));
  return app;
}

describe('buildCorsMiddleware (BS#2061)', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  // Both spies are installed for every block, and restored in afterEach rather
  // than at the end of an `it`. A per-test `mockRestore()` never runs when an
  // assertion throws, which would leave console mocked for the rest of the
  // file; and the FRONTEND_SOURCE-unset block legitimately triggers
  // resolveCorsOrigin's `[cors] None of ...` error, which would otherwise read
  // as a real failure in the CI log.
  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('with both configs set (the production shape after this ships)', () => {
    const env = { FRONTEND_SOURCE: DJ, PUBLIC_READ_ORIGINS: `${PUBLIC},https://www.wxyc.org` };

    it.each(['/flowsheet', '/flowsheet/range', '/flowsheet/search'])(
      'serves %s to wxyc.org with ACAO and WITHOUT credentials',
      async (path) => {
        const res = await request(appWith(env)).get(path).set('Origin', PUBLIC);
        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe(PUBLIC);
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      }
    );

    it('varies on Origin for both branches so a shared cache cannot cross-serve', async () => {
      // The `cors` package pushes Vary: Origin for the string and array forms
      // alike, so this held before the change and must keep holding: with two
      // branches selected by Origin, a missing Vary would let a cache hand a
      // wxyc.org reader the dj.wxyc.org ACAO.
      for (const origin of [PUBLIC, DJ]) {
        const res = await request(appWith(env)).get('/flowsheet').set('Origin', origin);
        expect(String(res.headers['vary'])).toMatch(/\bOrigin\b/);
      }
    });

    it('leaves dj.wxyc.org credentialed and unchanged on the same route', async () => {
      const res = await request(appWith(env)).get('/flowsheet').set('Origin', DJ);
      expect(res.headers['access-control-allow-origin']).toBe(DJ);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('does not grant wxyc.org a route outside the public set', async () => {
      const res = await request(appWith(env)).get('/library').set('Origin', PUBLIC);
      // The credentialed literal comes back, which the browser rejects because
      // it is not wxyc.org — the page cannot read this route, by design.
      expect(res.headers['access-control-allow-origin']).toBe(DJ);
    });

    it('does not grant wxyc.org a mutation on a public route', async () => {
      const res = await request(appWith(env)).post('/flowsheet').set('Origin', PUBLIC);
      expect(res.headers['access-control-allow-origin']).toBe(DJ);
    });

    it('answers a GET preflight from wxyc.org without credentials', async () => {
      const res = await request(appWith(env))
        .options('/flowsheet/range')
        .set('Origin', PUBLIC)
        .set('Access-Control-Request-Method', 'GET');
      expect(res.headers['access-control-allow-origin']).toBe(PUBLIC);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    // The preflight response is where the grant advertises its surface. Reusing
    // the credentialed method/header lists here would tell a wxyc.org page it
    // may attempt writes and send an internal key — on an allow-list that
    // exists purely for anonymous reads.
    it('advertises GET only, and no Authorization or X-Internal-Key, on a public preflight', async () => {
      const res = await request(appWith(env))
        .options('/flowsheet/range')
        .set('Origin', PUBLIC)
        .set('Access-Control-Request-Method', 'GET');
      expect(res.headers['access-control-allow-methods']).toBe('GET');
      const allowed = String(res.headers['access-control-allow-headers']);
      expect(allowed).not.toMatch(/Authorization/i);
      expect(allowed).not.toMatch(/X-Internal-Key/i);
      expect(allowed).toMatch(/Content-Type/i);
    });

    it('leaves the credentialed preflight advertising the full mutating surface', async () => {
      const res = await request(appWith(env))
        .options('/flowsheet')
        .set('Origin', DJ)
        .set('Access-Control-Request-Method', 'POST');
      expect(res.headers['access-control-allow-methods']).toBe('GET,POST,DELETE,PATCH');
      expect(String(res.headers['access-control-allow-headers'])).toMatch(/Authorization/);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('never echoes an unlisted origin', async () => {
      const res = await request(appWith(env)).get('/flowsheet').set('Origin', 'https://evil.example');
      expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    });

    it('leaves a request with no Origin exactly as it is today', async () => {
      // iOS, Android, curl and supertest all send no Origin. They ignore ACAO,
      // but the header must not change shape for them either.
      const res = await request(appWith(env)).get('/flowsheet');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(DJ);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });
  });

  describe('with PUBLIC_READ_ORIGINS unset (today, and local dev)', () => {
    const env = { FRONTEND_SOURCE: DJ };

    it('behaves exactly as it did before this change', async () => {
      const res = await request(appWith(env)).get('/flowsheet').set('Origin', PUBLIC);
      expect(res.headers['access-control-allow-origin']).toBe(DJ);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(String(res.headers['vary'])).toMatch(/\bOrigin\b/);
    });

    it('logs nothing about public origins', () => {
      appWith(env);
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe('with FRONTEND_SOURCE unset (BS#1107 fail-closed, preserved)', () => {
    it('serves no CORS headers to dj.wxyc.org', async () => {
      const res = await request(appWith({ PUBLIC_READ_ORIGINS: PUBLIC }))
        .get('/flowsheet')
        .set('Origin', DJ);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('still serves the public pages — the two configs are independent', async () => {
      const res = await request(appWith({ PUBLIC_READ_ORIGINS: PUBLIC }))
        .get('/flowsheet')
        .set('Origin', PUBLIC);
      expect(res.headers['access-control-allow-origin']).toBe(PUBLIC);
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });
  });
});
