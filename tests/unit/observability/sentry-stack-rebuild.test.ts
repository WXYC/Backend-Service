import * as SentryNode from '@sentry/node';
import type { ErrorEvent } from '@sentry/core';
import { redactSentryBreadcrumb, redactSentryEventQueryParams } from '@wxyc/observability';
import { SIGNUP_DJ_NAME, SIGNUP_REAL_NAME, captureFailedStationSignupInsert } from '../../utils/postgres-js-errors';

// Sentry parses `error.stack` into `exception.values[].stacktrace` before `beforeSend` runs, so a params line
// that survives in the stack text becomes frames carrying the bound values (BS#3054). These tests send a
// station-signup-shaped insert through the real schema, drizzle, postgres.js and @sentry/node.
const SENTINEL = SIGNUP_REAL_NAME;
const DJ_NAME = SIGNUP_DJ_NAME;
const TIMESTAMP = '2026-10-08';
// Every word of both names and the bound timestamp, so a frame holding any piece of them fails.
const BOUND_WORDS = [...SENTINEL.split(' '), ...DJ_NAME.split(' '), TIMESTAMP];

/** Which bound values appear anywhere in the event (a list, so a failure names them without dumping the event). */
const heldBy = (event: ErrorEvent) =>
  [SENTINEL, DJ_NAME, '16:23:45'].filter((needle) => JSON.stringify(event).includes(needle));

/** Everything @sentry/node sends for one captured error, through its default integrations and this repo's hooks. */
async function captureThroughSentry(error: unknown): Promise<ErrorEvent> {
  const sent: ErrorEvent[] = [];
  SentryNode.init({
    dsn: 'https://public@example.invalid/1',
    beforeSend: redactSentryEventQueryParams,
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
    expect(values.every((value) => (value.stacktrace?.frames?.length ?? 0) > 0)).toBe(true);
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
