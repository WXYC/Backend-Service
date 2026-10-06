import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { SpanJSON, TransactionEvent } from '@sentry/core';
import { filterSentryTransactionEvent, isExpressInstrumentationSpan, isLivenessRequestPath } from '@wxyc/observability';

function makeSpan(overrides: Partial<SpanJSON> = {}): SpanJSON {
  return {
    data: {},
    op: 'http.server',
    span_id: 'span1',
    start_timestamp: 0,
    trace_id: 'trace1',
    ...overrides,
  };
}

function makeTransactionEvent(overrides: Partial<TransactionEvent> = {}): TransactionEvent {
  return {
    type: 'transaction',
    transaction: 'GET /flowsheet',
    spans: [],
    ...overrides,
  };
}

describe('isLivenessRequestPath', () => {
  it.each([
    'https://api.wxyc.org/auth/ok',
    'http://localhost:8082/auth/ok',
    'https://api.wxyc.org/auth/ok/',
    'https://api.wxyc.org/auth/ok?probe=1',
    '/auth/ok',
    'https://api.wxyc.org/healthcheck',
    '/healthcheck',
  ])('flags %s as a liveness probe', (url) => {
    expect(isLivenessRequestPath(url)).toBe(true);
  });

  it.each([
    'https://api.wxyc.org/flowsheet',
    // The better-auth mount itself is real traffic (sign-in, session reads) and
    // must survive — only the /ok sub-path under it is a probe.
    'https://api.wxyc.org/auth',
    'https://api.wxyc.org/auth/sign-in/email',
    'https://api.wxyc.org/auth/ok/nested',
    // Not a prefix match: a route that merely ends in /ok is not the probe.
    'https://api.wxyc.org/library/ok',
  ])('does not flag %s', (url) => {
    expect(isLivenessRequestPath(url)).toBe(false);
  });

  it('does not flag undefined', () => {
    expect(isLivenessRequestPath(undefined)).toBe(false);
  });

  it('does not throw on an unparseable url', () => {
    expect(isLivenessRequestPath('http://[malformed')).toBe(false);
  });
});

// Sentry 11 (BS#2948) emits Express layer spans with origin
// `auto.http.express` and the generic `@sentry/conventions` ops below. They
// are restated rather than imported: the root `@sentry/conventions` is
// whatever copy something else hoisted (0.16 under Sentry 10, where these
// constants don't exist), not necessarily the one `@sentry/server-utils` uses.
const EXPRESS_ORIGIN = 'auto.http.express';
const MIDDLEWARE = 'middleware';
const ROUTER = 'router';
const HANDLER = 'handler';
const V11_EXPRESS_OPS = [MIDDLEWARE, ROUTER, HANDLER];

describe('isExpressInstrumentationSpan', () => {
  // `router` and `handler` (Sentry 10: `router.express`, `request_handler.express`)
  // were pinned as NOT flagged until BS#2406, reversing BS#2089's deliberate
  // exclusion.
  it.each(V11_EXPRESS_OPS)('flags Sentry 11 Express %s spans', (op) => {
    expect(isExpressInstrumentationSpan({ op, origin: EXPRESS_ORIGIN })).toBe(true);
  });

  // Kept so a pin back to Sentry 10 (done once already, 3c3e815e) doesn't
  // silently re-ship every Express span.
  it.each(['middleware.express', 'router.express', 'request_handler.express'])(
    'flags Sentry 10 Express %s spans',
    (op) => {
      expect(isExpressInstrumentationSpan({ op, origin: 'auto.http.otel.express' })).toBe(true);
    }
  );

  it.each([
    ['http.server', 'auto.http.node.http'],
    ['db', 'auto.db.postgresjs'],
    ['http.client', 'auto.http.node.fetch'],
    ['lml.lookup', 'manual'],
    // The generic ops alone are not enough: another framework integration
    // could emit them, and only Express's own bookkeeping is shed.
    [HANDLER, 'auto.http.hono'],
    [MIDDLEWARE, undefined],
    [undefined, undefined],
  ])('does not flag op %s with origin %s', (op, origin) => {
    expect(isExpressInstrumentationSpan({ op, origin })).toBe(false);
  });
});

describe('filterSentryTransactionEvent', () => {
  // Regression guard for the defect this filter shipped with: better-auth is
  // mounted at /auth, so Sentry names the /auth/ok probe's transaction
  // "GET /auth", not "GET /ok". Matching the transaction name dropped nothing
  // in production. These two cases pin the real shape.
  it('drops the /auth/ok probe even though its transaction is named GET /auth', () => {
    const event = makeTransactionEvent({
      transaction: 'GET /auth',
      request: { url: 'https://api.wxyc.org/auth/ok' },
    });
    expect(filterSentryTransactionEvent(event)).toBeNull();
  });

  it('keeps real /auth traffic sharing that transaction name', () => {
    const event = makeTransactionEvent({
      transaction: 'GET /auth',
      request: { url: 'https://api.wxyc.org/auth/get-session' },
    });
    expect(filterSentryTransactionEvent(event)).toBe(event);
  });

  it('drops the /healthcheck probe', () => {
    const event = makeTransactionEvent({
      transaction: 'GET /healthcheck',
      request: { url: 'https://api.wxyc.org/healthcheck' },
    });
    expect(filterSentryTransactionEvent(event)).toBeNull();
  });

  it('keeps a transaction with no request data', () => {
    const event = makeTransactionEvent({ transaction: 'GET /auth' });
    expect(filterSentryTransactionEvent(event)).toBe(event);
  });

  it('strips every express instrumentation span, keeping the spans that carry signal', () => {
    const event = makeTransactionEvent({
      transaction: 'GET /flowsheet',
      spans: [
        makeSpan({ span_id: 'a', op: MIDDLEWARE, origin: EXPRESS_ORIGIN, description: 'corsMiddleware' }),
        makeSpan({ span_id: 'b', op: MIDDLEWARE, origin: EXPRESS_ORIGIN, description: 'jsonParser' }),
        makeSpan({ span_id: 'c', op: ROUTER, origin: EXPRESS_ORIGIN, description: '/flowsheet' }),
        makeSpan({ span_id: 'd', op: HANDLER, origin: EXPRESS_ORIGIN, description: '/flowsheet' }),
        makeSpan({ span_id: 'e', op: 'db', description: 'SELECT 1' }),
        makeSpan({ span_id: 'f', op: 'http.client', description: 'GET lml' }),
      ],
    });

    const result = filterSentryTransactionEvent(event);
    expect(result?.spans?.map((s) => s.span_id)).toEqual(['e', 'f']);
  });

  // BS#2406 inverts this. It previously asserted both ops passed through
  // untouched, per BS#2089's rationale that they carry the information you
  // want when tracing a slow request. They cost 7.5% of the org's span budget
  // and the surviving db / http.client / custom spans carry the diagnosis.
  it('strips Express router and handler spans', () => {
    const event = makeTransactionEvent({
      transaction: 'GET /library',
      spans: [
        makeSpan({ span_id: 'a', op: ROUTER, origin: EXPRESS_ORIGIN }),
        makeSpan({ span_id: 'b', op: HANDLER, origin: EXPRESS_ORIGIN }),
      ],
    });

    const result = filterSentryTransactionEvent(event);
    expect(result?.spans).toHaveLength(0);
  });

  it('keeps a transaction whose spans were ALL filtered, rather than dropping it', () => {
    // `null` from this hook drops the whole transaction. Only a liveness path
    // may do that -- an ordinary request that happened to carry nothing but
    // framework bookkeeping must still report its duration and status.
    const event = makeTransactionEvent({
      transaction: 'GET /library',
      spans: [makeSpan({ span_id: 'a', op: ROUTER, origin: EXPRESS_ORIGIN })],
    });

    const result = filterSentryTransactionEvent(event);
    expect(result).not.toBeNull();
    expect(result?.transaction).toBe('GET /library');
    expect(result?.spans).toEqual([]);
  });

  it('passes a real transaction with no express instrumentation spans through unmodified', () => {
    const event = makeTransactionEvent({
      transaction: 'GET /flowsheet',
      spans: [makeSpan({ span_id: 'a', op: 'db', description: 'SELECT 1' })],
    });

    expect(filterSentryTransactionEvent(event)).toEqual(event);
  });

  it('passes through a transaction with no spans array', () => {
    const event = makeTransactionEvent({ transaction: 'GET /djs', spans: undefined });
    expect(filterSentryTransactionEvent(event)).toBe(event);
  });
});

describe('instrument.ts wiring', () => {
  it.each([
    ['backend', '../../../apps/backend/instrument.ts'],
    ['auth', '../../../apps/auth/instrument.ts'],
  ])('%s Sentry.init passes the shared filterSentryTransactionEvent as beforeSendTransaction', (_app, relPath) => {
    const source = readFileSync(resolve(__dirname, relPath), 'utf-8');
    expect(source).toMatch(/from ['"]@wxyc\/observability['"]/);
    expect(source).toMatch(/beforeSendTransaction:\s*filterSentryTransactionEvent/);
  });
  // The `traceLifecycle: 'static'` pin this filter depends on is asserted on
  // the real `Sentry.init` options in sentry-express-capture-wiring.test.ts.
});

// The runtime images' prod stages install and copy shared workspaces by
// explicit enumeration, so a new one is silently absent until it is listed.
// `@wxyc/observability` is imported by instrument.ts, which loads before app
// code — a missing dist is a boot crash, and no CI job builds these images.
// Pin all three Dockerfiles here instead.
//
// Since BS#2718 (shared builder image), every target's builder stage is
// `FROM ${BUILDER_IMAGE}`, fed by the single `Dockerfile.deploy-builder`
// build that runs `npm run build --workspace=shared/**` once for the whole
// fleet -- so the BS#2532 hazard this file originally guarded against (the
// worker's builder stage needing `@wxyc/observability` named explicitly, or
// its dist silently never gets built at all) no longer exists: every
// consumer gets every shared package's dist "for free" from the one shared
// build, the same way `Dockerfile.backend`/`Dockerfile.auth` always did. The
// per-target `COPY --from=builder` path is still worth pinning (a missing
// COPY is still a boot crash); the old worker-specific
// `--workspace=@wxyc/observability` assertion is gone because that flag no
// longer lives in any per-target Dockerfile.
describe('Dockerfile runtime stages ship @wxyc/observability', () => {
  it.each([
    ['backend', '../../../Dockerfile.backend'],
    ['auth', '../../../Dockerfile.auth'],
    ['enrichment-worker', '../../../Dockerfile.enrichment-worker'],
  ])('Dockerfile.%s copies the package manifest and the built dist', (_app, relPath) => {
    const source = readFileSync(resolve(__dirname, relPath), 'utf-8');
    expect(source).toContain('COPY ./shared/observability/package* ./shared/observability/');
    expect(source).toContain('COPY --from=builder /shared/observability/dist ./shared/observability/dist');
  });

  it('Dockerfile.deploy-builder builds every shared workspace unconditionally, not by per-target enumeration', () => {
    const source = readFileSync(resolve(__dirname, '../../../Dockerfile.deploy-builder'), 'utf-8');
    expect(source).toContain('--workspace=shared/**');
  });
});
