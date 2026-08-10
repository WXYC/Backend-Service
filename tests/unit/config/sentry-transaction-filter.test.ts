import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { SpanJSON, TransactionEvent } from '@sentry/core';
import { filterSentryTransactionEvent, isExpressMiddlewareSpan, isLivenessRequestPath } from '@wxyc/observability';

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

describe('isExpressMiddlewareSpan', () => {
  it('flags middleware.express spans', () => {
    expect(isExpressMiddlewareSpan({ op: 'middleware.express' })).toBe(true);
  });

  it.each(['router.express', 'request_handler.express', 'http.server', undefined])('does not flag %s spans', (op) => {
    expect(isExpressMiddlewareSpan({ op })).toBe(false);
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

  it('strips middleware.express spans from a real transaction', () => {
    const event = makeTransactionEvent({
      transaction: 'GET /flowsheet',
      spans: [
        makeSpan({ span_id: 'a', op: 'middleware.express', description: 'corsMiddleware' }),
        makeSpan({ span_id: 'b', op: 'middleware.express', description: 'jsonParser' }),
        makeSpan({ span_id: 'c', op: 'router.express', description: 'router - /flowsheet' }),
      ],
    });

    const result = filterSentryTransactionEvent(event);
    expect(result?.spans?.map((s) => s.span_id)).toEqual(['c']);
  });

  it('passes router.express and request_handler.express spans through untouched', () => {
    const event = makeTransactionEvent({
      transaction: 'GET /library',
      spans: [
        makeSpan({ span_id: 'a', op: 'router.express' }),
        makeSpan({ span_id: 'b', op: 'request_handler.express' }),
      ],
    });

    const result = filterSentryTransactionEvent(event);
    expect(result?.spans).toHaveLength(2);
    expect(result?.spans?.map((s) => s.span_id)).toEqual(['a', 'b']);
  });

  it('passes a real transaction with no middleware spans through unmodified', () => {
    const event = makeTransactionEvent({
      transaction: 'GET /flowsheet',
      spans: [makeSpan({ span_id: 'a', op: 'router.express' })],
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
});

// The runtime images install and copy shared workspaces by explicit
// enumeration, so a new one is silently absent until it is listed in both
// places. `@wxyc/observability` is imported by instrument.ts, which loads
// before app code — a missing dist is a boot crash, and no CI job builds these
// images. Pin both Dockerfiles here instead.
describe('Dockerfile runtime stages ship @wxyc/observability', () => {
  it.each([
    ['backend', '../../../Dockerfile.backend', 'builder'],
    ['auth', '../../../Dockerfile.auth', 'auth-builder'],
  ])('Dockerfile.%s copies the package manifest and the built dist', (_app, relPath, builderDir) => {
    const source = readFileSync(resolve(__dirname, relPath), 'utf-8');
    expect(source).toContain('COPY ./shared/observability/package* ./shared/observability/');
    expect(source).toContain(
      `COPY --from=builder ./${builderDir}/shared/observability/dist ./shared/observability/dist`
    );
  });
});
