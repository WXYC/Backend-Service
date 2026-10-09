import * as SentryNode from '@sentry/node';
import type { ErrorEvent, EventHint } from '@sentry/core';
import { inspect } from 'util';
import {
  redactLogValue,
  redactQueryParams,
  redactSentryBreadcrumb,
  redactSentryEventQueryParams,
} from '@wxyc/observability';
import {
  SIGNUP_DJ_NAME,
  SIGNUP_REAL_NAME,
  captureFailedStationSignupInsert,
  realDrizzleQueryError,
} from '../../utils/postgres-js-errors';

// Sentry parses `error.stack` into `exception.values[].stacktrace` before `beforeSend` runs, so a params line
// that survives in the stack text becomes frames carrying the bound values (BS#3054). These tests send a
// station-signup-shaped insert through the real schema, drizzle, postgres.js and @sentry/node.
const SENTINEL = SIGNUP_REAL_NAME;
const DJ_NAME = SIGNUP_DJ_NAME;
const TIMESTAMP = '2026-10-08';
// Every word of both names and the bound timestamp, so a frame holding any piece of them fails.
// Joined at run time so the test's own source (which Sentry attaches as context lines) does not hold the value.
const BOUND_TIMESTAMP = ['2026-10-08T16', '23', '45.123Z'].join(':');
const BOUND_WORDS = [...SENTINEL.split(' '), ...DJ_NAME.split(' '), TIMESTAMP];

/** Which bound values appear anywhere in the event (a list, so a failure names them without dumping the event). */
const heldBy = (event: ErrorEvent) =>
  [SENTINEL, DJ_NAME, '16:23:45'].filter((needle) => JSON.stringify(event).includes(needle));

/** Everything @sentry/node sends for one captured error, through its default integrations and this repo's hooks. */
async function captureThroughSentry(
  error: unknown,
  options: Partial<SentryNode.NodeOptions> = {},
  beforeSend: (event: ErrorEvent, hint: EventHint) => ErrorEvent = redactSentryEventQueryParams
): Promise<ErrorEvent> {
  const sent: ErrorEvent[] = [];
  SentryNode.init({
    dsn: 'https://public@example.invalid/1',
    ...options,
    beforeSend,
    beforeBreadcrumb: redactSentryBreadcrumb,
    transport: () => ({
      send: (envelope) => {
        for (const item of envelope[1]) if (item[0].type === 'event') sent.push(item[1] as ErrorEvent);
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
  });
  try {
    SentryNode.captureException(error);
    await SentryNode.flush(1000);
  } finally {
    await SentryNode.close(1000);
  }
  expect(sent).toHaveLength(1);
  return sent[0];
}

describe('redactSentryEventQueryParams rebuilds the stack from the redacted error', () => {
  it('sends no frame or other field holding a bound value, and keeps the real frames', async () => {
    const event = await captureThroughSentry(await captureFailedStationSignupInsert());

    const frames = event.exception?.values?.flatMap((value) => value.stacktrace?.frames ?? []) ?? [];
    expect(heldBy(event)).toEqual([]);
    for (const frame of frames) {
      for (const field of [frame.filename, frame.module, frame.function, frame.abs_path, frame.context_line]) {
        expect(BOUND_WORDS.filter((word) => (field ?? '').includes(word))).toEqual([]);
      }
    }
    expect(frames.some((frame) => /sentry-stack-rebuild\.test/.test(frame.filename ?? ''))).toBe(true);
    expect(event.exception?.values?.at(-1)?.value).toContain('params: [redacted]');
  });

  it('rebuilds each value of a cause chain from the matching redacted error', async () => {
    const event = await captureThroughSentry(
      new Error('signup failed', { cause: await captureFailedStationSignupInsert() })
    );

    const values = event.exception?.values ?? [];
    // postgres.js's connection error, drizzle's wrapper, then the outer error.
    expect(values.map((value) => value.value?.split('\n')[0])).toEqual([
      expect.stringContaining('ECONNREFUSED'),
      expect.stringContaining('Failed query'),
      'signup failed',
    ]);
    expect(heldBy(event)).toEqual([]);
    // Each value carries its own frames: postgres.js's connection error is thrown from node:net, the outer error here.
    const framesOf = (value: (typeof values)[number]) => (value.stacktrace?.frames ?? []).map((f) => f.filename ?? '');
    expect(framesOf(values[0]).some((file) => file.includes('node:net'))).toBe(true);
    expect(framesOf(values[0]).some((file) => file.includes('sentry-stack-rebuild.test'))).toBe(false);
    expect(framesOf(values[2]).some((file) => file.includes('sentry-stack-rebuild.test'))).toBe(true);
    expect(framesOf(values[2]).some((file) => file.includes('node:net'))).toBe(false);
  });

  it('carries the source context lines over to the rebuilt frames', async () => {
    const event = await captureThroughSentry(await captureFailedStationSignupInsert());

    const own = (event.exception?.values ?? [])
      .flatMap((value) => value.stacktrace?.frames ?? [])
      .filter((frame) => /sentry-stack-rebuild\.test/.test(frame.filename ?? ''));
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((frame) => typeof frame.context_line === 'string' && frame.context_line.length > 0)).toBe(true);
  });

  it('leaves a value whose class does not match the chain to the in-place scrub, which drops its stack', async () => {
    const event = await captureThroughSentry(await captureFailedStationSignupInsert(), {}, (sent, hint) => {
      const last = sent.exception?.values?.at(-1);
      if (last) last.type = 'NotTheThrownClass';
      return redactSentryEventQueryParams(sent, hint);
    });

    const last = event.exception?.values?.at(-1);
    expect(heldBy(event)).toEqual([]);
    expect(last?.value).toContain('params: [redacted]');
    expect(last?.stacktrace).toBeUndefined();
  });

  it('sends no helper frames when the error cannot be copied (a throwing detail getter)', async () => {
    const error = new Error(`Failed query: select 1\nparams: ${DJ_NAME},${SENTINEL},${BOUND_TIMESTAMP}`);
    Object.defineProperty(error, 'detail', {
      get() {
        throw new Error('unreadable');
      },
    });

    const event = await captureThroughSentry(error);

    const value = event.exception?.values?.at(-1);
    expect(heldBy(event)).toEqual([]);
    expect(value?.value).toBe('Failed query: select 1\nparams: [redacted]');
    expect(JSON.stringify(event.exception)).not.toMatch(/minimalError|redactQueryParams|rebuildExceptionValues/);
    expect(value?.stacktrace).toBeUndefined();
  });

  it('drops the stack when a message shortened after the stack was formatted leaves the params lines in it', async () => {
    const error = await captureFailedStationSignupInsert();
    // V8 formats `stack` on first read, so read it before shortening the message.
    expect(error.stack).toContain('params: ');
    error.message = error.message.slice(0, error.message.indexOf('\nparams: '));

    const event = await captureThroughSentry(error);

    expect(heldBy(event)).toEqual([]);
    expect(event.exception?.values?.at(-1)?.value).toContain('Failed query');
  });

  it('sends no bound value from a query error nine causes deep when linkedErrors follows twelve', async () => {
    let error: Error = await captureFailedStationSignupInsert();
    for (let i = 0; i < 9; i++) error = new Error(`wrapper ${i}`, { cause: error });

    const event = await captureThroughSentry(error, {
      integrations: [SentryNode.linkedErrorsIntegration({ limit: 12 })],
    });

    expect(event.exception?.values).toHaveLength(11);
    expect(heldBy(event)).toEqual([]);
  });

  it('copies a plain error whose message was reworded after the stack was formatted, and sends no stacktrace from the cut stack', async () => {
    const error = new Error(`Failed query: select 1\nparams: ${DJ_NAME},${SENTINEL},${BOUND_TIMESTAMP}`);
    expect(error.stack).toContain('params: ');
    error.message = 'select 1 failed';

    const event = await captureThroughSentry(error);

    expect(heldBy(event)).toEqual([]);
    expect(event.exception?.values?.at(-1)?.stacktrace).toBeUndefined();
  });

  it('sends no frame built from a params line whose first bound value starts with the redaction text', async () => {
    const error = new Error(
      `Failed query: select 1\nparams: [redacted] my review,${DJ_NAME},${SENTINEL},${BOUND_TIMESTAMP}`
    );
    expect(error.stack).toContain('params: ');
    error.message = 'Failed query: select 1';

    const event = await captureThroughSentry(error);

    expect(heldBy(event)).toEqual([]);
  });

  // A first bound value shaped like the redaction plus a frame must not pass for a redacted params line (BS#3070).
  it.each([
    ['a stack frame', `[redacted]\n    at ${SENTINEL},${DJ_NAME},${BOUND_TIMESTAMP}`],
    ['a function frame', `[redacted]\n    at review (${SENTINEL} ${DJ_NAME}:1:2)`],
    ['an async frame', `[redacted]\n    at async ${SENTINEL},${BOUND_TIMESTAMP}`],
    ['a frame and a second marker', `[redacted]\n    at ${SENTINEL},${BOUND_TIMESTAMP}\nparams: z`],
  ])(
    'sends no frame or log text from a shortened message whose first bound value imitates the redaction and %s',
    async (_label, bound) => {
      const error = new Error(`Failed query: select 1\nparams: ${bound}`);
      expect(error.stack).toContain('params: ');
      error.message = 'Failed query: select 1';

      const event = await captureThroughSentry(error);

      expect(heldBy(event)).toEqual([]);
      expect(inspect(redactQueryParams(error))).not.toContain(SENTINEL);
      expect(inspect(redactLogValue(error))).not.toContain(SENTINEL);
    }
  );

  // The rebuild cannot reach these values, so the in-place fallback must not keep frames built from the params lines.
  describe('when the rebuild cannot reach a shortened query error', () => {
    const shortened = () => {
      const error = realDrizzleQueryError([DJ_NAME, SENTINEL, BOUND_TIMESTAMP]);
      // V8 formats `stack` on first read, so read it before shortening the message.
      expect(error.stack).toContain('params: ');
      error.message = error.message.slice(0, error.message.indexOf('\nparams: '));
      return error;
    };
    const unreadableDetail = <T extends Error>(error: T): T =>
      Object.defineProperty(error, 'detail', {
        get() {
          throw new Error('unreadable');
        },
      });

    it('after the minimal-error fallback names a class Sentry did not (a throwing detail getter)', async () => {
      const event = await captureThroughSentry(unreadableDetail(shortened()));

      expect(heldBy(event)).toEqual([]);
      expect(event.exception?.values?.at(-1)?.stacktrace).toBeUndefined();
    });

    it('when the minimal copy of the outer error has no cause to follow', async () => {
      const event = await captureThroughSentry(unreadableDetail(new Error('signup failed', { cause: shortened() })));

      const values = event.exception?.values ?? [];
      expect(values).toHaveLength(3);
      expect(heldBy(event)).toEqual([]);
      expect(values.some((value) => value.type === 'DrizzleQueryError' && value.stacktrace !== undefined)).toBe(false);
    });

    it('inside an AggregateError', async () => {
      const event = await captureThroughSentry(new AggregateError([shortened()], 'bootstrap failed'));

      expect(heldBy(event)).toEqual([]);
    });

    it('keeps the stacktrace of an unreached value whose chain holds no params line', async () => {
      const event = await captureThroughSentry(unreadableDetail(new Error('signup failed', { cause: new Error('x') })));

      expect(event.exception?.values?.[0].stacktrace).toBeDefined();
    });
  });

  it('sends no bound value from a query error nine causes deep whose message was shortened', async () => {
    const inner = await captureFailedStationSignupInsert();
    // V8 formats `stack` on first read, so read it before shortening the message.
    expect(inner.stack).toContain('params: ');
    inner.message = inner.message.slice(0, inner.message.indexOf('\nparams: '));
    let error: Error = inner;
    for (let i = 0; i < 9; i++) error = new Error(`wrapper ${i}`, { cause: error });

    const event = await captureThroughSentry(error, {
      integrations: [SentryNode.linkedErrorsIntegration({ limit: 12 })],
    });

    expect(event.exception?.values).toHaveLength(11);
    expect(heldBy(event)).toEqual([]);
  });

  it('withholds a stack it cannot rebuild rather than keep one built from the params lines', () => {
    const message = `Failed query: select 1\nparams: abc,${DJ_NAME},${SENTINEL},2026-10-08T16:23:45.123Z`;
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          {
            type: 'DrizzleQueryError',
            value: message,
            stacktrace: {
              frames: [
                { filename: '/app/src/service.ts', function: 'save', lineno: 10 },
                { filename: `${DJ_NAME},abc,${SENTINEL},${TIMESTAMP}T16`, module: SENTINEL, lineno: 23, colno: 45 },
              ],
            },
          },
        ],
      },
    };

    const result = redactSentryEventQueryParams(event);

    expect(heldBy(result)).toEqual([]);
    expect(result.exception?.values?.[0].value).toBe('Failed query: select 1\nparams: [redacted]');
  });
});
