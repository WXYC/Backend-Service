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
import {
  captureRealDrizzleQueryError,
  postgresJsServerError,
  realDrizzleQueryError,
} from '../../utils/postgres-js-errors';

const SENTINEL = 'Test Reviewer';
const SQL = 'insert into "reviews" ("review", "author") values ($1, $2)';

/**
 * drizzle-orm's real error class, so the message format under test is Drizzle's own, around a driver
 * error with postgres.js's real (non-configurable) property shape unless a cause is given.
 */
function queryError(params: string[] = ['great record', SENTINEL], cause?: unknown): DrizzleQueryError {
  return new DrizzleQueryError(SQL, params, (cause as Error | undefined) ?? postgresJsServerError(params));
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

  it('cuts the stack at a params line a shortened message leaves behind', () => {
    const error = queryError();
    // V8 formats `stack` on first read, so read it before shortening the message.
    expect(error.stack).toContain(SENTINEL);
    error.message = `Failed query: ${SQL}`;

    const redacted = redactQueryParams(error);

    expect(String(redacted.stack)).not.toContain(SENTINEL);
    expect(String(redacted.stack)).toContain(`Failed query: ${SQL}`);
  });

  // The guards decide by the position of the params marker, never by what follows it or what a bound value says: a first value that merely
  // starts with the redaction text must not pass for a redacted line (the writer would choose the prefix).
  it.each([
    ['a first bound value that starts with the redaction text', `[redacted] my review,DJ Cat Scratch,${SENTINEL},ts`],
    ['a first bound value that is the redaction text followed by a separator', `[redacted],${SENTINEL},ts`],
    ['a first bound value that is the redaction text and a line break', `[redacted]\nmy review,${SENTINEL},ts`],
    [
      'a first bound value that imitates the redaction and a stack frame',
      `[redacted]\n    at ${SENTINEL},DJ Cat Scratch,ts`,
    ],
    ['a first bound value that imitates the redaction and an async frame', `[redacted]\n    at async ${SENTINEL},ts`],
    [
      'a first bound value that imitates the redaction, a frame and a second marker',
      `[redacted]\n    at ${SENTINEL},ts\nparams: z`,
    ],
  ])('cuts the stack of a shortened message whose params line has %s', (_label, bound) => {
    const error = new Error(`Failed query: select 1\nparams: ${bound}`);
    // V8 formats `stack` on first read, so read it before shortening the message.
    expect(error.stack).toContain(SENTINEL);
    error.message = 'Failed query: select 1';

    expect(String(redactQueryParams(error).stack)).not.toContain(SENTINEL);
    expect(inspect(redactQueryParams(error))).not.toContain(SENTINEL);
    expect(inspect(redactLogValue(error))).not.toContain(SENTINEL);
  });

  it('copies an error whose message needs nothing but whose stack still holds a params line, so the log line is clean', () => {
    const error = new Error(`Failed query: select 1\nparams: DJ Cat Scratch,${SENTINEL},ts`);
    expect(error.stack).toContain(SENTINEL);
    error.message = 'select 1 failed';

    const redacted = redactQueryParams(error);

    expect(redacted).not.toBe(error);
    expect(inspect(redacted)).not.toContain(SENTINEL);
    expect(inspect(redactLogValue(error))).not.toContain(SENTINEL);
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

  it('drops the bound-value properties postgres.js attaches to its errors, which it defines non-configurable', () => {
    const driver = postgresJsServerError([SENTINEL], { code: '23502' });
    expect(Object.getOwnPropertyDescriptor(driver, 'parameters')).toMatchObject({
      writable: false,
      configurable: false,
    });

    const redacted = redactQueryParams(new Error('wrapper', { cause: driver })).cause as typeof driver;

    expect(everything(redacted)).not.toContain(SENTINEL);
    expect((redacted as { code?: string }).code).toBe('23502');
  });

  it('redacts a DrizzleQueryError around a postgres.js error without throwing', () => {
    const error = realDrizzleQueryError([SENTINEL, 'u1'], { code: '23502' });

    const redacted = redactQueryParams(error);

    expect(everything(redacted)).not.toContain(SENTINEL);
    expect(redacted).toBeInstanceOf(DrizzleQueryError);
    expect((redacted.cause as { code?: string }).code).toBe('23502');
    expect((redacted.cause as { query?: string }).query).toContain('update "auth_user"');
  });

  it('redacts the error drizzle and postgres.js really throw (closed port, no database)', async () => {
    const error = await captureRealDrizzleQueryError(SENTINEL);
    expect(Object.getOwnPropertyDescriptor(error.cause, 'parameters')?.configurable).toBe(false);

    const redacted = redactQueryParams(error);

    expect(error.message).toContain(SENTINEL);
    expect(everything(redacted)).not.toContain(SENTINEL);
    expect(redactLogValue({ arguments: [error] })).toBeDefined();
  });

  describe('never throws', () => {
    const throwingMessage = () => {
      const e = new Error('x');
      Object.defineProperty(e, 'message', {
        get() {
          throw new Error('getter boom');
        },
      });
      return e;
    };
    const throwingProperty = () => {
      const e = new Error(`Failed query: ${SQL}\nparams: ${SENTINEL}`);
      Object.defineProperty(e, 'code', {
        get() {
          throw new Error('getter boom');
        },
        enumerable: true,
      });
      return e;
    };

    it.each([
      ['a frozen error', () => Object.freeze(queryError())],
      ['an error whose message getter throws', throwingMessage],
      ['an error with a throwing property getter', throwingProperty],
      [
        'a Proxy whose traps throw',
        () =>
          new Proxy(queryError(), {
            ownKeys() {
              throw new Error('trap boom');
            },
            getOwnPropertyDescriptor() {
              throw new Error('trap boom');
            },
          }),
      ],
    ])('for %s, and the result holds no bound value', (_label, build) => {
      let redacted: unknown;
      expect(() => {
        redacted = redactQueryParams(build());
      }).not.toThrow();
      expect(() => redactLogValue(build())).not.toThrow();
      expect(() => redactSentryBreadcrumb({ message: 'm', data: { arguments: [build()] } })).not.toThrow();
      expect(everything(redacted)).not.toContain(SENTINEL);
    });

    it('falls back to the class name and redacted message for an error it cannot copy', () => {
      const redacted = redactQueryParams(
        new Proxy(queryError(), {
          ownKeys() {
            throw new Error('trap boom');
          },
        })
      );

      expect(redacted).toMatchObject({ message: `Failed query: ${SQL}\nparams: [redacted]` });
      expect(String((redacted as Error).name)).toBe('DrizzleQueryError');
    });
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

  it('returns the same object when nothing in it needs redacting, so the logger prints it unchanged', () => {
    const circular: Record<string, unknown> = { note: 'ok' };
    circular.self = circular;
    const withGetter = {
      get lazy() {
        throw new Error('must not be called');
      },
    };
    const values = [
      { a: 1, b: ['x', { c: 'y' }] },
      ['x', 1, { y: 2 }],
      withGetter,
      { [Symbol('key')]: 1, n: 1 },
      Object.assign(Object.create(null), { n: 1 }),
      circular,
      Object.freeze({ n: 1 }),
    ];

    for (const value of values) expect(redactLogValue(value)).toBe(value);
  });

  it('copies only what changes: other members, accessors and symbol keys of the copy survive', () => {
    const key = Symbol('key');
    let reads = 0;
    const value = {
      [key]: 'kept',
      get lazy() {
        reads++;
        return 'computed';
      },
      wrapped: queryError(),
    };

    const result = redactLogValue(value) as typeof value;

    expect(result).not.toBe(value);
    expect(everything(result.wrapped)).not.toContain(SENTINEL);
    expect(result[key]).toBe('kept');
    expect(Object.getOwnPropertyDescriptor(result, 'lazy')?.get).toBeDefined();
    expect(reads).toBe(0);
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

  // Sentry's console instrumentation attaches once per process, so both error shapes go through one init.
  it('scrubs what Sentry actually sends: a console breadcrumb, then a captured event, for a postgres.js-shaped error and the one drizzle and postgres.js really throw', async () => {
    const sent: ErrorEvent[] = [];
    // The console integration wraps console.error as it stands at init, so mute it first and keep the wrapper.
    const muted = [jest.spyOn(console, 'error'), jest.spyOn(console, 'warn')].map((spy) => spy.mockImplementation());
    SentryNode.init({
      dsn: 'https://public@example.invalid/1',
      defaultIntegrations: false,
      integrations: [SentryNode.consoleIntegration()],
      beforeBreadcrumb: redactSentryBreadcrumb,
      beforeSend: (event) => {
        sent.push(redactSentryEventQueryParams(event));
        return null;
      },
    });
    const errors = [queryError(), await captureRealDrizzleQueryError(SENTINEL)];

    for (const error of errors) {
      SentryNode.withIsolationScope(() => {
        console.error('[UPDATE IDENTITY] Unexpected error:', error);
        SentryNode.captureException(error);
      });
    }
    await SentryNode.flush(1000);
    muted.forEach((spy) => spy.mockRestore());

    expect(sent).toHaveLength(2);
    for (const event of sent) {
      expect(event.breadcrumbs?.length).toBeGreaterThan(0);
      expect(JSON.stringify(event.breadcrumbs)).toContain('Failed query');
      expect(JSON.stringify(event)).not.toContain(SENTINEL);
    }
  });
});
