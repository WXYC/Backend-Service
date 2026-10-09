import { inspect } from 'util';
import type { ErrorEvent } from '@sentry/core';
import { redactQueryParams, redactSentryEventQueryParams } from '@wxyc/observability';

const SENTINEL = 'Test Reviewer';
const SQL = 'insert into "reviews" ("author", "body") values ($1, $2)';

/** The message drizzle-orm 0.45's `DrizzleQueryError` builds: the SQL, then every bound value. */
function queryError(params: string[] = [SENTINEL, 'great record'], cause?: unknown): Error {
  const error = new Error(`Failed query: ${SQL}\nparams: ${params.join(',')}`, { cause });
  Object.assign(error, { query: SQL, params });
  return error;
}

function eventFor(...errors: Array<{ value: string }>): ErrorEvent {
  return { type: undefined, exception: { values: errors } };
}

describe('redactQueryParams', () => {
  it.each([
    ['a failed query', () => queryError()],
    ['a failed query nested as a cause', () => new Error('wrapper', { cause: queryError() })],
    ['a failed query two causes deep', () => new Error('outer', { cause: new Error('mid', { cause: queryError() }) })],
  ])('removes bound values from %s, in the message, stack, properties and cause chain', (_label, build) => {
    const redacted = redactQueryParams(build());

    expect(JSON.stringify(redacted, Object.getOwnPropertyNames(redacted))).not.toContain(SENTINEL);
    expect(String(redacted.stack)).not.toContain(SENTINEL);
    expect(inspect(redacted, { depth: 10 })).not.toContain(SENTINEL);
  });

  it('keeps the SQL text and a params marker so the failure stays debuggable', () => {
    const redacted = redactQueryParams(queryError());

    expect(redacted.message).toBe(`Failed query: ${SQL}\nparams: [redacted]`);
  });

  it('keeps a postgres cause reachable under the redacted error', () => {
    const cause = Object.assign(new Error('duplicate key value'), { code: '23505' });

    const redacted = redactQueryParams(queryError(undefined, cause));

    expect(redacted.cause).toBe(cause);
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['a message with no params part', new Error(`Failed query: ${SQL}`)],
    ['a non-Error value', 'just a string'],
  ])('returns %s unchanged', (_label, value) => {
    expect(redactQueryParams(value)).toBe(value);
  });
});

describe('redactSentryEventQueryParams', () => {
  it('rewrites every exception value in the chain, keeping the SQL', () => {
    const event = eventFor({ value: 'outer' }, { value: queryError().message });

    const result = redactSentryEventQueryParams(event);

    expect(result.exception?.values?.map((e) => e.value)).toEqual([
      'outer',
      `Failed query: ${SQL}\nparams: [redacted]`,
    ]);
  });

  it('rewrites breadcrumb messages that quote a failed query', () => {
    const event: ErrorEvent = { type: undefined, breadcrumbs: [{ message: queryError().stack }, { message: 'ok' }] };

    const result = redactSentryEventQueryParams(event);

    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(result.breadcrumbs?.[1].message).toBe('ok');
  });

  it('leaves an event with no exception untouched', () => {
    const event: ErrorEvent = { type: undefined, message: 'hello' };

    expect(redactSentryEventQueryParams(event)).toEqual({ type: undefined, message: 'hello' });
  });
});
