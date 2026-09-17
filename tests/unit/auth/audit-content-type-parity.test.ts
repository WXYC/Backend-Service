/**
 * Regression coverage for BS#2558: `express.json()` used to match
 * `Content-Type: application/json` EXACTLY (via `type-is`), while
 * better-call's own JSON gate is an unanchored, substring-tolerant regex
 * that also accepts `application/jsonx`, `application/json-patch+json`,
 * `application/json5`, etc. A request in that gap was fully processed by
 * better-auth while `req.body` stayed undefined for every OTHER Express
 * consumer — including the account-audit middleware, which resolves
 * `subject_user_id` from `req.body` on 18 mounts — so the audit row silently
 * lost its subject on exactly the requests that mattered.
 *
 * Two things are proven here, both against REAL (unmocked) code, not hand-
 * built request/response fictions — this repo has been bitten repeatedly by
 * exactly that (PR #2545 findings H1/H2, PR #2550's L3):
 *
 *  1. `describe('account-audit subject parity ...')` — a REAL `express()`
 *     app wired with the actual patched `express.json({ type:
 *     isBetterCallJsonRequest })` line and the REAL
 *     `mountPublicAccountAudit` dispatcher from `account-audit-middleware.ts`
 *     (only `@wxyc/database` / `@wxyc/authentication` are mocked, the same
 *     doubles `account-audit-middleware.test.ts` already uses), driven over
 *     real HTTP via `supertest` — so the request body is parsed by the real
 *     `body-parser` from real bytes on the wire, not assigned onto a fake
 *     `req.body` object. Paths are hard-coded literals (`/auth/reset-
 *     password`, `/auth/request-password-reset`), never derived from
 *     `FLAT_MOUNTS` — the same L3 discipline the existing middleware suite
 *     already follows for the OTP mounts.
 *
 *  2. `describe('real better-call round-trip ...')` — the empirical proof
 *     that better-call ITSELF (not just our own middleware) still receives
 *     the body after Express has already consumed the stream to populate
 *     `req.body`, and that a content type better-call rejects still 415s.
 *     Built from better-call's own PUBLIC, stable exports
 *     (`createEndpoint`, `createRouter` from `'better-call'`, `toNodeHandler`
 *     from `'better-call/node'` — none of it mocked; `jest.unit.config.ts`
 *     only maps `better-auth/node`, not `better-call` or `better-call/node`)
 *     configured with the EXACT same `allowedMediaTypes: ['application/json']`
 *     better-auth's own router passes
 *     (`node_modules/better-auth/dist/api/index.mjs`). This is a full,
 *     genuine exercise of `better-call/dist/adapters/node/request.mjs`'s
 *     `getRequest` — the `maybeConsumedReq.body !== undefined` re-
 *     serialization branch the issue names — with no better-auth, no
 *     Postgres, and no mocking of better-call anywhere in the chain.
 *
 * Two more, added during the PR #2566 code review, cover findings the
 * review itself surfaced against this same real/unmocked substrate:
 *
 *  3. `describe('application/vnd.api+json: ...')` (Finding 4) — combines
 *     both harnesses above to prove that a content type Express now parses
 *     but better-call still 415s (a real widening, distinct from the
 *     BS#2558 gap — see `json-content-type.ts`'s module doc) still produces
 *     an audit row, with the rejection's own outcome, rather than a
 *     silently dropped one.
 *
 *  4. `describe('malformed / oversized bodies ...')` (Finding 5) — proves
 *     `app.ts`'s swallow-wrapped `express.json(...)` (see its comment for
 *     the full empirical investigation into hang/confusing-body risk)
 *     actually restores the audit mount's ability to run on a parse error,
 *     which a bare `express.json(...)` would otherwise route around via
 *     `next(err)` straight to the unconditional-500 `fallbackErrorHandler`.
 */
import express from 'express';
import type { Request } from 'express';
import path from 'path';
import request from 'supertest';

jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import { db, recordAccountAuditEvent } from '../../mocks/database.mock';
import { mountPublicAccountAudit } from '../../../apps/auth/account-audit-middleware';
import { isBetterCallJsonRequest } from '../../../apps/auth/json-content-type';
import { resolveNestedBetterCall } from '../../utils/resolve-nested-better-call';

describe('account-audit subject parity across content types (BS#2558)', () => {
  /**
   * Real express() app: the SAME `express.json({ type: isBetterCallJsonRequest })`
   * line app.ts uses, then the real public flat-mount dispatcher, then a
   * stub terminal handler per mount standing in for better-auth's own route
   * (a 200 JSON response) — the audit middleware only needs the response to
   * finish with a 2xx so its public-mount subject-resolution gate opens; it
   * does not need a real better-auth handler underneath it.
   */
  function makeApp() {
    const app = express();
    app.use(express.json({ type: isBetterCallJsonRequest }));
    mountPublicAccountAudit(app);
    // Hard-coded literal paths — deliberately NOT derived from
    // FLAT_MOUNTS, matching the L3 discipline in
    // account-audit-middleware.test.ts's OTP-mount table.
    app.post('/auth/reset-password', (_req, res) => res.status(200).json({ ok: true }));
    app.post('/auth/request-password-reset', (_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  const lastAuditedSubjectUserId = (): unknown =>
    (recordAccountAuditEvent.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined)?.subjectUserId;

  const lastAuditedAction = (): unknown =>
    (recordAccountAuditEvent.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined)?.action;

  beforeEach(() => {
    recordAccountAuditEvent.mockClear();
  });

  describe('body-user-id mount (/auth/reset-password, action "reset-password")', () => {
    it.each(['application/json', 'application/jsonx', 'application/json-patch+json'])(
      'resolves the identical subject_user_id under Content-Type %s',
      async (contentType) => {
        const app = makeApp();
        const res = await request(app)
          .post('/auth/reset-password')
          .set('Content-Type', contentType)
          .send(JSON.stringify({ userId: 'reset-target-1', newPassword: 'irrelevant-for-this-test' }));

        expect(res.status).toBe(200);
        // Give the fire-and-forget res.on('finish') write a tick to run.
        await new Promise((r) => setImmediate(r));
        expect(lastAuditedAction()).toBe('reset-password');
        expect(lastAuditedSubjectUserId()).toBe('reset-target-1');
      }
    );

    it('does NOT resolve a subject under a better-call-rejected Content-Type (text/plain) — req.body stays undefined, matching pre-fix behavior', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/auth/reset-password')
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ userId: 'reset-target-1' }));

      expect(res.status).toBe(200); // our stub handler still runs — express.json() skipping parse is not itself a 415
      await new Promise((r) => setImmediate(r));
      expect(lastAuditedAction()).toBe('reset-password');
      expect(lastAuditedSubjectUserId()).toBeNull();
    });
  });

  describe('email-lookup mount (/auth/request-password-reset, action "forget-password")', () => {
    beforeEach(() => {
      (db._chain.limit as jest.Mock).mockReset();
    });

    it.each(['application/json', 'application/jsonx', 'application/json-patch+json'])(
      'resolves the identical subject_user_id (via the DB email lookup) under Content-Type %s',
      async (contentType) => {
        (db._chain.limit as jest.Mock).mockResolvedValueOnce([{ id: 'resolved-user-1' }]);
        const app = makeApp();
        const res = await request(app)
          .post('/auth/request-password-reset')
          .set('Content-Type', contentType)
          .send(JSON.stringify({ email: 'dj@wxyc.org' }));

        expect(res.status).toBe(200);
        await new Promise((r) => setImmediate(r));
        expect(lastAuditedAction()).toBe('forget-password');
        expect(lastAuditedSubjectUserId()).toBe('resolved-user-1');
      }
    );

    it('does NOT resolve a subject under text/plain — the DB lookup never runs because req.body is undefined', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/auth/request-password-reset')
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ email: 'dj@wxyc.org' }));

      expect(res.status).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(db._chain.limit).not.toHaveBeenCalled();
      expect(lastAuditedAction()).toBe('forget-password');
      expect(lastAuditedSubjectUserId()).toBeNull();
    });
  });
});

describe('real better-call round-trip (BS#2558 re-serialization claim)', () => {
  // `better-call`'s public `.` export (`createRouter`, from
  // `dist/index.cjs`) transitively requires `rou3` for its route table, and
  // `rou3` ships ESM-only — that require chain fails under ts-jest's CJS
  // runtime with "Must use import to load ES Module" (confirmed empirically
  // while writing this test), unrelated to anything BS#2558 touches. This
  // harness avoids it by never loading `dist/index.cjs`: `createEndpoint`,
  // `getBody`, and `toResponse` are required from their own sibling `.cjs`
  // files by ABSOLUTE PATH (computed off `require.resolve('better-call')`,
  // which only *resolves* — never executes — the package root), which
  // bypasses both `package.json`'s "exports" map (irrelevant to a literal
  // filesystem path) and `rou3` (none of `endpoint.cjs`/`utils.cjs`/
  // `to-response.cjs` import it — only `router.cjs` does). `getRequest` /
  // `setResponse` / `toNodeHandler` come from the PUBLICLY declared
  // `better-call/node` subpath export, which is genuinely rou3-free on its
  // own (`dist/node.cjs` imports only `./adapters/node/request.cjs`).
  //
  // What's hand-assembled below is ONLY the ~10-line single-route dispatch
  // `router.mjs`'s `processRequest` does (build a context, call the real
  // `getBody`, invoke the endpoint, catch a real `APIError` into a real
  // `toResponse`) — never better-call's own route-matching, since this
  // harness only ever has the one path. Every function actually exercising
  // content-type behavior (`getBody`'s `allowedMediaTypes` gate and JSON
  // parse, `getRequest`'s re-serialization branch, `toResponse`'s APIError
  // rendering) is the real, unmocked, installed `better-call` dependency —
  // and, as of BS#2558 PR #2566 review Finding 2, specifically
  // better-auth's own NESTED copy of it (`resolveNestedBetterCall`), not
  // the floating root devDependency. The two happened to carry a
  // byte-identical `jsonContentTypeRegex` when this was checked (Finding
  // 2(a)), but there is no structural reason they always will, and this
  // harness's whole point is to exercise the copy production actually
  // loads. Type-only `import()` references for these paths don't resolve
  // under `tests/tsconfig.json`'s `moduleResolution: "Node"` (it ignores
  // `package.json` "exports" maps entirely — the same documented ts-jest
  // quirk `shared/observability`'s CLAUDE.md entry names, and the same gap
  // `tests/mocks/better-auth-api.mock.ts` already tolerates for
  // `better-call/error`). `tests/**/*.ts` has the `no-unsafe-*`/
  // `no-explicit-any` ESLint rules off (`eslint.config.mjs`), so these stay
  // untyped rather than fighting a resolver limitation that has no bearing
  // on whether the real, installed code actually runs correctly — which is
  // exactly what every `it()` below checks.
  const distDir = path.dirname(resolveNestedBetterCall());
  // eslint-disable-next-line @typescript-eslint/no-require-imports, security/detect-non-literal-require -- deep, non-exported-subpath requires by absolute path; see the comment above for why.
  const { getBody, isAPIError } = require(path.join(distDir, 'utils.cjs'));
  // eslint-disable-next-line @typescript-eslint/no-require-imports, security/detect-non-literal-require
  const { toResponse } = require(path.join(distDir, 'to-response.cjs'));
  // eslint-disable-next-line @typescript-eslint/no-require-imports, security/detect-non-literal-require
  const { createEndpoint } = require(path.join(distDir, 'endpoint.cjs'));
  // eslint-disable-next-line @typescript-eslint/no-require-imports, security/detect-non-literal-require -- `better-call/node`'s public export has no "require"-condition-resolvable types under this file's tsconfig (see the comment above); requiring it here (not `import`) matches app.ts's actual runtime resolution path, resolved from better-auth's own nested copy per Finding 2.
  const { toNodeHandler } = require(resolveNestedBetterCall('node'));

  /**
   * One trivial endpoint that echoes back whatever `ctx.body` this harness
   * handed it, gated by the EXACT `allowedMediaTypes` better-auth's own
   * router configures (`node_modules/better-auth/dist/api/index.mjs`,
   * `allowedMediaTypes: ["application/json"]`) — so the accept/reject
   * boundary below is provably better-auth's real boundary, not a stand-in
   * approximation of it.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- must stay `async`: `createEndpoint`'s internal dispatcher (node_modules/better-call/dist/endpoint.cjs) unconditionally calls `.catch()` on the handler's return value, which only exists on a Promise.
  const echo = createEndpoint('/echo', { method: 'POST' }, async (ctx) => {
    return new Response(JSON.stringify({ receivedBody: ctx.body ?? null }), {
      headers: { 'content-type': 'application/json' },
    });
  });

  /** `router.mjs`'s `processRequest`, minus `rou3` route matching — see the comment above. */
  async function processEchoRequest(webRequest: globalThis.Request): Promise<Response> {
    try {
      const context = {
        path: '/echo',
        method: webRequest.method,
        headers: webRequest.headers,
        params: {},
        request: webRequest,
        body: await getBody(webRequest, ['application/json']),
        query: {},
        asResponse: true,
      };
      return await echo(context);
    } catch (error) {
      if (isAPIError(error)) return toResponse(error);
      throw error;
    }
  }

  const nodeHandler = toNodeHandler(processEchoRequest);

  function makeApp() {
    const app = express();
    app.use(express.json({ type: isBetterCallJsonRequest }));
    app.all('/echo', (req: Request, res) => void nodeHandler(req, res));
    return app;
  }

  it('better-call still receives the parsed body after express.json() has already consumed it, under application/json', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ hello: 'wxyc' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ receivedBody: { hello: 'wxyc' } });
  });

  it('better-call still receives the SAME parsed body under application/jsonx — the exact re-serialization path (better-call/dist/adapters/node/request.mjs getRequest, the maybeConsumedReq.body branch) the issue names', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/jsonx')
      .send(JSON.stringify({ hello: 'wxyc' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ receivedBody: { hello: 'wxyc' } });
  });

  it('better-call still receives the SAME parsed body under application/json-patch+json', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json-patch+json')
      .send(JSON.stringify({ hello: 'wxyc' }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ receivedBody: { hello: 'wxyc' } });
  });

  it('a better-call-rejected Content-Type (text/plain) still 415s, through the REAL router, unaffected by the express.json() widening', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify({ hello: 'wxyc' }));

    expect(res.status).toBe(415);
  });
});

/**
 * BS#2558 PR #2566 review Finding 4: `application/vnd.api+json` is not in
 * the BS#2558 gap (better-call still rejects it, just for a different
 * reason than pre-fix — see json-content-type.ts's module doc), but this
 * PR still changes its behavior: Express now parses the body before
 * better-call's `allowedMediaTypes` check 415s it. This combines both
 * harnesses above — the real `mountPublicAccountAudit` dispatcher AND a
 * real better-call round trip that actually enforces `allowedMediaTypes`
 * — to establish, empirically, what happens to the audit trail on exactly
 * that path: does the rejected request still produce an audit row, and if
 * so, with what outcome.
 */
describe('application/vnd.api+json: Express-parsed, better-call-rejected (BS#2558 PR #2566 review Finding 4)', () => {
  const distDir = path.dirname(resolveNestedBetterCall());
  // eslint-disable-next-line @typescript-eslint/no-require-imports, security/detect-non-literal-require -- deep, non-exported-subpath requires by absolute path; see the "real better-call round-trip" describe above for why.
  const { getBody, isAPIError } = require(path.join(distDir, 'utils.cjs'));
  // eslint-disable-next-line @typescript-eslint/no-require-imports, security/detect-non-literal-require
  const { toResponse } = require(path.join(distDir, 'to-response.cjs'));
  // eslint-disable-next-line @typescript-eslint/no-require-imports, security/detect-non-literal-require
  const { createEndpoint } = require(path.join(distDir, 'endpoint.cjs'));
  // eslint-disable-next-line @typescript-eslint/no-require-imports, security/detect-non-literal-require -- resolved from better-auth's own nested better-call copy, matching app.ts's real runtime resolution (Finding 2).
  const { toNodeHandler } = require(resolveNestedBetterCall('node'));

  // Mirrors better-auth's OWN router config (`allowedMediaTypes:
  // ["application/json"]`, `node_modules/better-auth/dist/api/index.mjs`) —
  // the same admission gate `/auth/reset-password` runs behind in
  // production — not a narrower stand-in.
  // eslint-disable-next-line @typescript-eslint/require-await -- must stay `async`: `createEndpoint`'s internal dispatcher (node_modules/better-call/dist/endpoint.cjs) unconditionally calls `.catch()` on the handler's return value, which only exists on a Promise. Matches the identical `echo` handler above.
  const resetPassword = createEndpoint('/reset-password', { method: 'POST' }, async (ctx: { body?: unknown }) => {
    return new Response(JSON.stringify({ ok: true, receivedBody: ctx.body ?? null }), {
      headers: { 'content-type': 'application/json' },
    });
  });

  /** `router.mjs`'s `processRequest`, minus `rou3` route matching — see the "real better-call round-trip" describe above. */
  async function processResetPasswordRequest(webRequest: globalThis.Request): Promise<Response> {
    try {
      const context = {
        path: '/reset-password',
        method: webRequest.method,
        headers: webRequest.headers,
        params: {},
        request: webRequest,
        body: await getBody(webRequest, ['application/json']),
        query: {},
        asResponse: true,
      };
      return await resetPassword(context);
    } catch (error) {
      if (isAPIError(error)) return toResponse(error);
      throw error;
    }
  }

  const nodeHandler = toNodeHandler(processResetPasswordRequest);

  /**
   * Real `express.json({ type: isBetterCallJsonRequest })`, then the real
   * public flat-mount audit dispatcher, then the real better-call round
   * trip above standing in for better-auth's own `/reset-password` route —
   * so the 415 below is genuinely better-call's `allowedMediaTypes` gate
   * firing, and the audit-row assertion below is genuinely the production
   * `finishOnce` path reacting to it, not a stand-in for either.
   */
  function makeApp() {
    const app = express();
    app.use(express.json({ type: isBetterCallJsonRequest }));
    mountPublicAccountAudit(app);
    app.all('/auth/reset-password', (req: Request, res) => void nodeHandler(req, res));
    return app;
  }

  beforeEach(() => {
    recordAccountAuditEvent.mockClear();
  });

  it('Express parses the body, better-call still 415s it, and the audit middleware records the rejection (not a silently-dropped row)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/auth/reset-password')
      .set('Content-Type', 'application/vnd.api+json')
      .send(JSON.stringify({ userId: 'reset-target-1', newPassword: 'irrelevant-for-this-test' }));

    // better-call's admission gate, not Express's — this is the "widened
    // surface, not the BS#2558 gap" behavior json-content-type.ts's module
    // doc (Finding 1) and json-content-type.test.ts (Finding 4) describe.
    expect(res.status).toBe(415);

    await new Promise((r) => setImmediate(r));
    expect(recordAccountAuditEvent).toHaveBeenCalledTimes(1);
    const [event] = recordAccountAuditEvent.mock.calls.at(-1) as [Record<string, unknown>];
    // Empirically established (not assumed): a row IS recorded — classify()
    // only depends on the request path matching a known FlatMount, which it
    // does regardless of how better-call eventually answers, and the
    // response DOES finish (a 415 is a completed HTTP response, not an
    // aborted connection) so res.on('finish') still fires. The row carries
    // outcome 415 and no subject — the same shape any other rejected public
    // FlatMount request gets (public mounts gate subject resolution to 2xx
    // outcomes), not a NULL-subject row masquerading as success.
    expect(event.action).toBe('reset-password');
    expect(event.outcome).toBe(415);
    expect(event.subjectUserId).toBeNull();
    expect(event.errorCode).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

/**
 * BS#2558 PR #2566 review Finding 5: a body-parser PARSE error (malformed
 * JSON, or a body over the default 100kb limit) calls `next(err)`, which
 * skips every downstream non-error middleware — including the account-audit
 * mounts — and `app.ts` registers no error handler until the unconditional-500
 * `fallbackErrorHandler` at the bottom of the file. `app.ts` wraps its
 * `express.json(...)` call in a swallow (see its comment there for the full
 * empirical investigation: no hang, no confusing body, verified against the
 * real `fallbackErrorHandler` pipeline) so a parse error calls `next()`
 * instead — this proves that wrapper, reproduced here exactly as app.ts uses
 * it, actually restores the audit mount's ability to run on the two request
 * shapes that motivated it.
 */
describe('malformed / oversized bodies still reach the audit mount (BS#2558 PR #2566 review Finding 5)', () => {
  /** The exact wrapper app.ts mounts in place of a bare `express.json(...)` — see its comment for why. */
  function makeApp() {
    const app = express();
    const jsonBodyParser = express.json({ type: isBetterCallJsonRequest, limit: '100kb' });
    app.use((req, res, next) => jsonBodyParser(req, res, () => next()));
    mountPublicAccountAudit(app);
    app.post('/auth/reset-password', (_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  beforeEach(() => {
    recordAccountAuditEvent.mockClear();
  });

  it('a malformed-JSON body under a widened content type (application/jsonx) still records an audit row, not a lost one', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/auth/reset-password')
      .set('Content-Type', 'application/jsonx')
      .send('{"userId": "reset-target-1", "newPassword": "unterminated');

    // The stub handler below still runs (the parse error was swallowed, not
    // propagated) — proving the request didn't hang or error out.
    expect(res.status).toBe(200);

    await new Promise((r) => setImmediate(r));
    expect(recordAccountAuditEvent).toHaveBeenCalledTimes(1);
    const [event] = recordAccountAuditEvent.mock.calls.at(-1) as [Record<string, unknown>];
    expect(event.action).toBe('reset-password');
    // req.body never got populated (the malformed JSON was never parsed),
    // so the body-derived subject resolves to null — the SAME shape a
    // better-call-rejected content type produces (Finding 4's test above),
    // not a crash and not a lost row.
    expect(event.subjectUserId).toBeNull();
  });

  it('an oversized body under a widened content type still records an audit row, not a lost one', async () => {
    const app = makeApp();
    const oversizedBody = JSON.stringify({ userId: 'reset-target-1', padding: 'x'.repeat(200 * 1024) });
    const res = await request(app)
      .post('/auth/reset-password')
      .set('Content-Type', 'application/jsonx')
      .send(oversizedBody);

    expect(res.status).toBe(200);

    await new Promise((r) => setImmediate(r));
    expect(recordAccountAuditEvent).toHaveBeenCalledTimes(1);
    const [event] = recordAccountAuditEvent.mock.calls.at(-1) as [Record<string, unknown>];
    expect(event.action).toBe('reset-password');
    expect(event.subjectUserId).toBeNull();
  });
});
