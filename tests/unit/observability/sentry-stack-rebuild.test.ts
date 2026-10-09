import * as SentryNode from '@sentry/node';
import type { ErrorEvent, EventHint } from '@sentry/core';
import { createHash } from 'crypto';
import { inspect } from 'util';
import {
  redactLogValue,
  redactQueryParams,
  redactSentryBreadcrumb,
  redactSentryEventQueryParams,
} from '@wxyc/observability';
import {
  MESSAGE_CUTS,
  SIGNUP_DJ_NAME,
  SIGNUP_REAL_NAME,
  alteredFailedQuery,
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

// Each of a name's last word and the bound time, so a cut that keeps only the rest of a params line still fails.
// Built at run time: Sentry attaches this file's own lines to frames as context.
const LEAK_PIECES = [SENTINEL.split(' ').at(-1), DJ_NAME.split(' ').at(-1), BOUND_TIMESTAMP.slice(11, 19)] as string[];
const leaksIn = (text: string) => LEAK_PIECES.filter((piece) => text.includes(piece));
const dump = (value: unknown) => inspect(value, { depth: 10, showHidden: true });
const KINDS = ['drizzle', 'plain'] as const;

/** Everything one altered failed query can reach: the log line, a console breadcrumb, and what Sentry sends. */
async function sinksOf(error: Error) {
  const breadcrumb = redactSentryBreadcrumb({ message: 'console', data: { arguments: [redactQueryParams(error)] } });
  const event = await captureThroughSentry(error);
  return {
    log: leaksIn(dump(redactQueryParams(error)) + dump(redactLogValue(error))),
    breadcrumb: leaksIn(dump(breadcrumb)),
    sent: leaksIn(JSON.stringify(event)),
    event,
  };
}

// A message cut at or after the start of the params marker (a length cap is the likeliest edit) leaves the rest of
// the params line after the swapped message with no marker in it; the position rule alone cannot cut that.
describe('a failed query whose message was cut after the stack was formatted', () => {
  it.each(KINDS.flatMap((kind) => MESSAGE_CUTS.map(([label, at]) => [kind, label, at] as const)))(
    'a %s error cut %s reaches no log line, console breadcrumb or Sentry frame',
    async (kind, _label, at) => {
      const { log, breadcrumb, sent, event } = await sinksOf(alteredFailedQuery(kind, (m) => m.slice(0, at(m))));

      expect({ log, breadcrumb, sent }).toEqual({ log: [], breadcrumb: [], sent: [] });
      expect(event.exception?.values?.at(-1)?.value).toContain('Failed query');
    }
  );

  it.each(KINDS)(
    'a %s error cut just before the marker reaches no log line, console breadcrumb or Sentry frame',
    async (kind) => {
      const { log, breadcrumb, sent } = await sinksOf(
        alteredFailedQuery(kind, (m) => m.slice(0, m.indexOf('\nparams: ')))
      );

      expect({ log, breadcrumb, sent }).toEqual({ log: [], breadcrumb: [], sent: [] });
    }
  );

  // The message becomes text the stack holds only inside the params line, so "the marker comes before the message" must cut.
  it.each(KINDS.flatMap((kind) => [['a bound value', 'great record'] as const].map((row) => [kind, ...row] as const)))(
    'a %s error reworded to %s reaches no log line, console breadcrumb or Sentry frame',
    async (kind, _label, reworded) => {
      const { log, breadcrumb, sent } = await sinksOf(alteredFailedQuery(kind, () => reworded));

      expect({ log, breadcrumb, sent }).toEqual({ log: [], breadcrumb: [], sent: [] });
    }
  );

  it.each(KINDS)('a %s error reworded to the bare marker reaches no log line or Sentry frame', async (kind) => {
    const { log, breadcrumb, sent } = await sinksOf(alteredFailedQuery(kind, () => '\nparams: '));

    expect({ log, breadcrumb, sent }).toEqual({ log: [], breadcrumb: [], sent: [] });
  });
});

// The issue's constraint: an error that never held a params marker produces the event it would without the hook.
describe('an error that never held a params marker', () => {
  // A length and a digest, not the serialized event: a failure then names the case instead of diffing megabytes.
  const sentException = (event: ErrorEvent) => {
    const text = JSON.stringify({ exception: event.exception, extra: event.extra });
    return { length: text.length, sha256: createHash('sha256').update(text).digest('hex') };
  };

  /** The event for the same error made twice at one call site, without the hook and with it. */
  async function eventsWithAndWithoutHook(make: () => Error, options: Partial<SentryNode.NodeOptions> = {}) {
    const [first, second] = [0, 1].map(() => make());
    const without = await captureThroughSentry(first, options, (event) => event);
    const withHook = await captureThroughSentry(second, options);
    return { without, withHook };
  }
  const members = (count: number) => Array.from({ length: count }, (_, i) => new Error(`member ${i}`));
  const limit12 = { integrations: [SentryNode.linkedErrorsIntegration({ limit: 12 })] };
  const cyclic = () => {
    const a = new Error('a');
    const b = new TypeError('b', { cause: a });
    a.cause = b;
    return a;
  };
  const chain = (length: number) => {
    let error = new Error('root');
    for (let i = 1; i < length; i++) error = new Error(`wrapper ${i}`, { cause: error });
    return error;
  };

  it.each([
    ['an AggregateError of 70 plain errors', () => new AggregateError(members(70), 'agg'), {}],
    // Past the 64 nodes and the round powers of two (256, 1024) a small budget on the walk would be, and below its
    // 10,000-error budget (the case past it is the fresh-error-per-read getter below). Each member is a Sentry value, so the cost is Sentry's.
    ['an AggregateError of 2000 plain errors', () => new AggregateError(members(2000), 'agg'), {}],
    [
      'an AggregateError whose member causes the aggregate',
      () => {
        const aggregate = new AggregateError([], 'agg');
        aggregate.errors.push(new Error('member', { cause: aggregate }));
        return aggregate;
      },
      {},
    ],
    ['a cause cycle', cyclic, {}],
    ['a cause cycle with linkedErrors limit 12', cyclic, limit12],
    ['a plain chain of 12 with linkedErrors limit 12', () => chain(12), limit12],
    ['a plain chain of 30 with linkedErrors limit 12', () => chain(30), limit12],
  ])(
    '%s sends the event it would without the hook',
    async (_label, make, options) => {
      const { without, withHook } = await eventsWithAndWithoutHook(make, options);

      expect(sentException(withHook)).toEqual(sentException(without));
      expect(withHook.exception?.values?.some((value) => value.stacktrace === undefined)).toBe(false);
    },
    30_000
  );
});

// Sentry stops at its `limit`; the hook's walk of the raw chain must stop too (BS#3070).
describe('an error whose cause getter builds a fresh error on every read', () => {
  let reads = 0;
  class Lazy extends Error {
    get cause() {
      reads++;
      return new Lazy('lazy');
    }
  }
  // The throwing `detail` makes the copy fall back to the minimal error, so the rebuild stops at the first value and the walk runs.
  const lazy = () => {
    const error = new Lazy('lazy');
    Object.defineProperty(error, 'detail', {
      get() {
        throw new Error('unreadable');
      },
    });
    return error;
  };

  // Counted rather than timed: building an error costs far more under jest's source maps than in a bare process, so a
  // wall-clock bound would measure the machine. Without the budget the walk never returns, so reaching the assertions is the proof.
  it('is sent after the walk gives up at its budget, with the values the rebuild did not reach left without a stacktrace', async () => {
    reads = 0;

    const event = await captureThroughSentry(lazy());

    const values = event.exception?.values ?? [];
    expect(reads).toBeGreaterThan(9_000);
    expect(reads).toBeLessThan(10_100);
    expect(values.length).toBeGreaterThan(1);
    expect(values.map((value) => value.stacktrace)).toEqual(values.map(() => undefined));
  }, 30_000);
});

// The content backstop in the rebuild loop: reached through a link the copy chain does not own.
describe('a cause that is an inherited getter returning a raw failed query', () => {
  class Wrapper extends Error {
    constructor(
      message: string,
      private readonly inner: Error
    ) {
      super(message);
      this.name = 'Error';
    }

    get cause() {
      return this.inner;
    }
  }

  it('sends no frame built from the inner error params line', async () => {
    const event = await captureThroughSentry(new Wrapper('signup failed', await captureFailedStationSignupInsert()));

    expect(event.exception?.values?.length).toBeGreaterThan(1);
    expect(heldBy(event)).toEqual([]);
  });
});

describe('the rebuild asked to decide about values it did not reach', () => {
  it('withholds their stacktraces when the walk of the raw chain throws, since it cannot tell', async () => {
    let armed = false;
    // Sentry has read `errors` by the time `beforeSend` runs; only the hook's own walk still reads it.
    const aggregate = new AggregateError([new Error('member')], 'agg');
    Object.defineProperty(aggregate, 'errors', {
      get() {
        if (armed) throw new Error('unreadable');
        return [new Error('member')];
      },
    });

    const event = await captureThroughSentry(aggregate, {}, (sent, hint) => {
      armed = true;
      return redactSentryEventQueryParams(sent, hint);
    });

    const values = event.exception?.values ?? [];
    expect(values.length).toBeGreaterThan(1);
    expect(values.slice(0, -1).map((value) => value.stacktrace)).toEqual(values.slice(0, -1).map(() => undefined));
  });

  it('keeps those stacktraces when the walk completes and no raw error held a marker', async () => {
    const aggregate = new AggregateError([new Error('member')], 'agg');

    const event = await captureThroughSentry(aggregate);

    expect(event.exception?.values?.[0].stacktrace).toBeDefined();
  });
});

// Sentry follows an object tagged `[object Error]` down `cause` and `errors`, so the guards must walk it too.
describe('an object that Sentry follows as an error without being one', () => {
  const taggedAfter = (shortened: Error) => ({
    [Symbol.toStringTag]: 'Error',
    name: 'Error',
    message: 'Failed query: select 1',
    stack: String(shortened.stack),
  });

  const tagged = () => taggedAfter(alteredFailedQuery('drizzle', (m) => m));

  it.each([
    ['a cause', () => new Error('signup failed', { cause: tagged() })],
    ['an AggregateError member', () => new AggregateError([tagged()], 'bootstrap failed')],
  ])('as %s sends no frame built from its params line', async (_label, make) => {
    const event = await captureThroughSentry(make());

    expect(leaksIn(JSON.stringify(event))).toEqual([]);
  });

  // An AggregateError's `errors` are not descended into on the log side (a documented limit), so only a cause is pinned.
  it('as a cause logs no params line', () => {
    const error = new Error('signup failed', { cause: tagged() });

    expect(leaksIn(dump(redactQueryParams(error)) + dump(redactLogValue(error)))).toEqual([]);
  });
});
