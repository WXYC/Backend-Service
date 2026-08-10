import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { SpanJSON, TransactionEvent } from '@sentry/core';
import { filterSentryTransactionEvent, isExpressMiddlewareSpan, isLivenessTransaction } from '@wxyc/observability';

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

describe('isLivenessTransaction', () => {
  it.each(['GET /ok', 'GET /healthcheck'])('flags %s as a liveness transaction', (name) => {
    expect(isLivenessTransaction(name)).toBe(true);
  });

  it('does not flag a real route transaction', () => {
    expect(isLivenessTransaction('GET /flowsheet')).toBe(false);
  });

  it('does not flag undefined', () => {
    expect(isLivenessTransaction(undefined)).toBe(false);
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
  it('drops GET /ok transactions entirely', () => {
    const event = makeTransactionEvent({ transaction: 'GET /ok' });
    expect(filterSentryTransactionEvent(event)).toBeNull();
  });

  it('drops GET /healthcheck transactions entirely', () => {
    const event = makeTransactionEvent({ transaction: 'GET /healthcheck' });
    expect(filterSentryTransactionEvent(event)).toBeNull();
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
