import { inspect } from 'util';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import * as SentryNode from '@sentry/node';
import type { ErrorEvent } from '@sentry/core';
import {
  redactLogValue,
  redactQueryParams,
  redactSentryBreadcrumb,
  redactSentryEventQueryParams,
} from '@wxyc/observability';

const SENTINEL = 'Test Reviewer';
const SQL = 'insert into "reviews" ("review", "author") values ($1, $2)';

/** drizzle-orm's real error class, so the message format under test is Drizzle's own. */
function queryError(params: string[] = ['great record', SENTINEL], cause?: unknown): DrizzleQueryError {
  return new DrizzleQueryError(SQL, params, cause as Error | undefined);
}

function everything(error: unknown): string {
  const own = error instanceof Error ? Object.getOwnPropertyNames(error) : undefined;
  return `${inspect(error, { depth: 10, showHidden: true })} ${JSON.stringify(error, own)}`;
}

describe('redactQueryParams', () => {
  it.each([
    ['a failed query', () => queryError()],
    ['a failed query nested as a cause', () => new Error('wrapper', { cause: queryError() })],
    ['a failed query two causes deep', () => new Error('outer', { cause: new Error('mid', { cause: queryError() }) })],
    // The review text binds before `author`; a value that looks like a stack frame must not end the redaction.
    ['a bound value shaped like a stack frame', () => queryError(['Recorded\n    at the Cradle', SENTINEL])],
    ['a bound value holding the params marker', () => queryError(['x\nparams: y\n    at z', SENTINEL])],
    ['a bound value that is a long multi-line review', () => queryError(['one\n    at two\n    at three', SENTINEL])],
  ])('removes bound values from %s, in the message, stack, properties and cause chain', (_label, build) => {
    const redacted = redactQueryParams(build());

    expect(everything(redacted)).not.toContain(SENTINEL);
    expect(String(redacted.stack)).not.toContain(SENTINEL);
  });

  it('keeps the SQL text, a params marker and the stack frames so the failure stays debuggable', () => {
    const redacted = redactQueryParams(queryError());

    expect(redacted.message).toBe(`Failed query: ${SQL}\nparams: [redacted]`);
    expect(redacted.stack).toContain(`Failed query: ${SQL}\nparams: [redacted]\n    at `);
    expect(redacted.stack).toContain('redact-query-params.test');
  });

  it('keeps the input class and its other own properties, and leaves the input untouched', () => {
    const original = Object.assign(queryError(), { code: '23505', status: 409, expose: true });

    const redacted = redactQueryParams(original);

    expect(redacted).toBeInstanceOf(DrizzleQueryError);
    expect(redacted.name).toBe(original.name);
    expect(redacted).toMatchObject({ code: '23505', status: 409, expose: true, query: SQL });
    expect(redacted.params).toBe('[redacted]');
    expect(original.params).toEqual(['great record', SENTINEL]);
    expect(original.message).toContain(SENTINEL);
  });

  it('keeps a postgres cause reachable under the redacted error', () => {
    const cause = Object.assign(new Error('duplicate key value'), { code: '23505' });

    const redacted = redactQueryParams(queryError(undefined, cause));

    expect(redacted.cause).toBe(cause);
  });

  it('drops the bound-value properties postgres.js attaches to its errors', () => {
    const driver = Object.assign(new Error('boom'), { code: '23502', parameters: [SENTINEL], args: [SENTINEL] });

    const redacted = redactQueryParams(new Error('wrapper', { cause: driver })).cause as typeof driver;

    expect(everything(redacted)).not.toContain(SENTINEL);
    expect(redacted.code).toBe('23502');
  });

  it.each([
    ['a NOT NULL violation', 'Failing row contains (12, Test Reviewer, null)'],
    ['a CHECK violation', 'Failing row contains (1, 2, Test Reviewer)'],
  ])('redacts the whole-row detail of %s on the error and on its cause', (_label, detail) => {
    const driver = Object.assign(new Error('null value in column'), { code: '23502', detail });

    const redacted = redactQueryParams(queryError(undefined, driver));

    expect(everything(redacted)).not.toContain(SENTINEL);
    expect((redacted.cause as { detail: string }).detail).toBe('Failing row contains ([redacted])');
    expect((redacted.cause as { code: string }).code).toBe('23502');
  });

  it('keeps a constraint detail that carries only ids', () => {
    const detail = 'Key (album_id)=(42) is not present in table "library".';
    const driver = Object.assign(new Error('violates foreign key constraint'), { code: '23503', detail });

    const redacted = redactQueryParams(queryError(undefined, driver));

    expect((redacted.cause as { detail: string }).detail).toBe(detail);
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['a message with no params part', new Error(`Failed query: ${SQL}`)],
    ['a non-Error value', 'just a string'],
  ])('returns %s unchanged', (_label, value) => {
    expect(redactQueryParams(value)).toBe(value);
  });

  it('does not recurse forever on a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;

    expect(() => redactQueryParams(a)).not.toThrow();
  });
});

describe('redactLogValue', () => {
  it('scrubs strings, errors and the errors inside arrays and plain objects', () => {
    const value = ['x', queryError().message, { wrapped: queryError(), n: 1 }];

    expect(everything(redactLogValue(value))).not.toContain(SENTINEL);
  });

  it('passes other values through', () => {
    const date = new Date();
    expect(redactLogValue(date)).toBe(date);
    expect(redactLogValue(5)).toBe(5);
    expect(redactLogValue(null)).toBeNull();
  });
});

describe('redactSentryEventQueryParams', () => {
  it('rewrites every exception value in the chain, keeping the SQL', () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: { values: [{ value: 'outer' }, { value: queryError().message }] },
    };

    const result = redactSentryEventQueryParams(event);

    expect(result.exception?.values?.map((e) => e.value)).toEqual([
      'outer',
      `Failed query: ${SQL}\nparams: [redacted]`,
    ]);
  });

  it('redacts to the end of the value even when a bound value looks like a stack frame', () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: { values: [{ value: queryError(['Recorded\n    at the Cradle', SENTINEL]).message }] },
    };

    expect(JSON.stringify(redactSentryEventQueryParams(event))).not.toContain(SENTINEL);
  });

  it('leaves an event with no exception untouched', () => {
    const event: ErrorEvent = { type: undefined, message: 'hello' };

    expect(redactSentryEventQueryParams(event)).toEqual({ type: undefined, message: 'hello' });
  });
});

describe('redactSentryBreadcrumb', () => {
  // The shape @sentry/core's `addConsoleBreadcrumb` records: the formatted message plus the raw arguments.
  const consoleBreadcrumb = (error: Error) => ({
    category: 'console',
    level: 'error' as const,
    message: `[UPDATE IDENTITY] Unexpected error: ${error.stack}`,
    data: { arguments: ['[UPDATE IDENTITY] Unexpected error:', error], logger: 'console' },
  });

  it('scrubs the message and every console argument, including an Error and its cause chain', () => {
    const error = new Error('wrapper', { cause: queryError() });

    const result = redactSentryBreadcrumb(consoleBreadcrumb(error));

    expect(everything(result)).not.toContain(SENTINEL);
    expect((result.data?.arguments as unknown[])[0]).toBe('[UPDATE IDENTITY] Unexpected error:');
    expect(result.data?.logger).toBe('console');
  });

  it('copies the breadcrumb and leaves the logged error untouched', () => {
    const error = queryError();
    const breadcrumb = consoleBreadcrumb(error);

    redactSentryBreadcrumb(breadcrumb);

    expect(breadcrumb.data.arguments[1]).toBe(error);
    expect(error.message).toContain(SENTINEL);
  });

  it('keeps a breadcrumb with no data', () => {
    expect(redactSentryBreadcrumb({ message: 'ok', category: 'http' })).toEqual({ message: 'ok', category: 'http' });
  });

  it('scrubs what Sentry actually sends: a console breadcrumb, then a captured event', () => {
    const sent: ErrorEvent[] = [];
    // The console integration wraps console.error as it stands at init, so mute it first and keep the wrapper.
    const muted = [jest.spyOn(console, 'error'), jest.spyOn(console, 'warn')].map((spy) => spy.mockImplementation());
    SentryNode.init({
      dsn: 'https://public@example.invalid/1',
      defaultIntegrations: false,
      integrations: [SentryNode.consoleIntegration()],
      beforeBreadcrumb: redactSentryBreadcrumb,
      beforeSend: (event) => {
        sent.push(event);
        return null;
      },
    });
    const error = queryError();

    SentryNode.withIsolationScope(() => {
      console.error('[UPDATE IDENTITY] Unexpected error:', error);
      SentryNode.captureException(error);
    });

    return SentryNode.flush(1000).then(() => {
      muted.forEach((spy) => spy.mockRestore());
      expect(sent).toHaveLength(1);
      expect(sent[0].breadcrumbs?.length).toBeGreaterThan(0);
      expect(JSON.stringify(sent[0].breadcrumbs)).toContain('Failed query');
      expect(JSON.stringify(sent[0].breadcrumbs)).not.toContain(SENTINEL);
    });
  });
});
