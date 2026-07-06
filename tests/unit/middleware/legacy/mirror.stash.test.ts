/**
 * BS#1513 review follow-up (PR #1532): the flowsheet mutation responses are
 * projected through the client-facing allow-list, but the legacy mirror
 * middleware consumes the response body tapped into `res.locals.mirrorData` —
 * including `legacy_entry_id`, which the BS#908 loop guards and the restart
 * fallback read. Controllers therefore pre-stash the UNPROJECTED row via
 * `stashMirrorData`, and `tapJsonResponse` must not clobber it. These tests
 * pin that seam at the middleware level; the controller-side stash calls are
 * pinned in flowsheet.controller.test.ts.
 */

import { EventEmitter } from 'events';

jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import {
  createHttpMirrorMiddleware,
  stashMirrorData,
} from '../../../../apps/backend/middleware/legacy/mirror.middleware';

function makeRes(statusCode = 200) {
  const emitter = new EventEmitter();
  const res: Record<string, unknown> = {
    statusCode,
    locals: {},
    getHeader: jest.fn().mockReturnValue('application/json'),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
  };
  res.send = jest.fn().mockReturnValue(res);
  return res as unknown as {
    statusCode: number;
    locals: Record<string, unknown>;
    send: (body?: unknown) => unknown;
    emit: (event: string) => boolean;
  };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe('mirror middleware stash (BS#1513)', () => {
  beforeEach(() => {
    // isMirrorEnabled short-circuits to enabled when PostHog is unconfigured.
    delete process.env.POSTHOG_API_KEY;
  });

  it('hands the mirror the pre-stashed unprojected row, not the projected response body', async () => {
    const received: unknown[] = [];
    const mw = createHttpMirrorMiddleware<Record<string, unknown>>((_req, data) => {
      received.push(data);
      return Promise.resolve();
    });
    const res = makeRes();
    const next = jest.fn();
    await mw({} as never, res as never, next);
    expect(next).toHaveBeenCalled();

    stashMirrorData(res as never, {
      id: 42,
      play_order: 3,
      legacy_entry_id: 9999,
      add_time: new Date('2024-02-01T12:00:00Z'),
    });
    // The controller then sends the projected body (legacy_entry_id stripped).
    res.send(JSON.stringify({ id: 42, play_order: 3 }));
    res.emit('finish');
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: 42, play_order: 3, legacy_entry_id: 9999 });
    // JSON-parity with the previously-tapped body: dates arrive as ISO strings,
    // exactly the parsed-JSON shape the mirror handlers were built against.
    expect((received[0] as Record<string, unknown>).add_time).toBe('2024-02-01T12:00:00.000Z');
  });

  it('still taps the response body when nothing was stashed', async () => {
    const received: unknown[] = [];
    const mw = createHttpMirrorMiddleware<Record<string, unknown>>((_req, data) => {
      received.push(data);
      return Promise.resolve();
    });
    const res = makeRes();
    await mw({} as never, res as never, jest.fn());

    res.send(JSON.stringify({ id: 7, play_order: 1 }));
    res.emit('finish');
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ id: 7, play_order: 1 });
  });

  it('treats a nullish stash as a no-op so the tap still captures the response body', async () => {
    const received: unknown[] = [];
    const mw = createHttpMirrorMiddleware<Record<string, unknown>>((_req, data) => {
      received.push(data);
      return Promise.resolve();
    });
    const res = makeRes();
    await mw({} as never, res as never, jest.fn());

    // A future call site stashing a service result without a missing-row
    // guard must not crash the request or silently disable the mirror — the
    // tap falls through to the response body, exactly the pre-stash behavior.
    stashMirrorData(res as never, undefined);
    stashMirrorData(res as never, null);
    res.send(JSON.stringify({ id: 7, play_order: 1 }));
    res.emit('finish');
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ id: 7, play_order: 1 });
  });

  it('keeps last-write-wins for unstashed re-entrant sends (res.send(object) delegating through res.json)', async () => {
    const received: unknown[] = [];
    const mw = createHttpMirrorMiddleware<Record<string, unknown>>((_req, data) => {
      received.push(data);
      return Promise.resolve();
    });
    const res = makeRes();
    await mw({} as never, res as never, jest.fn());

    // Express's res.send(obj) re-enters the tapped send: first with the live
    // object, then (via res.json) with the serialized string. The parsed
    // string must win — the shape the mirror handlers were built against —
    // as it did before the stash guard existed.
    res.send({ id: 7, add_time: new Date('2024-02-01T12:00:00Z') });
    res.send(JSON.stringify({ id: 7, add_time: '2024-02-01T12:00:00.000Z' }));
    res.emit('finish');
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ id: 7, add_time: '2024-02-01T12:00:00.000Z' });
  });

  it('does not run mirror work for non-2xx responses even when a row was stashed', async () => {
    const received: unknown[] = [];
    const mw = createHttpMirrorMiddleware<Record<string, unknown>>((_req, data) => {
      received.push(data);
      return Promise.resolve();
    });
    const res = makeRes(404);
    await mw({} as never, res as never, jest.fn());

    stashMirrorData(res as never, { id: 42, legacy_entry_id: 9999 });
    res.send(JSON.stringify({ status: 404, message: 'not found' }));
    res.emit('finish');
    await flush();

    expect(received).toHaveLength(0);
  });
});
