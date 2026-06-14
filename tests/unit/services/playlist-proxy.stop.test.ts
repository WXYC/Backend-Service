/**
 * Tests for stopPlaylistProxy lifecycle and reconnect-timer hygiene.
 *
 * The 'error' handler unconditionally schedules `reconnectTimer =
 * setTimeout(() => connectSSE(), reconnectDelay)`. Two failure modes
 * fall out of that (BS#1132):
 *
 *   1. Cancellation race — if `stopPlaylistProxy()` runs *before* a
 *      pending reconnect fires, the queued reconnect still wakes up
 *      and reopens the upstream connection the operator just asked
 *      to tear down.
 *
 *   2. Stacked timers — if multiple 'error' events fire in quick
 *      succession before any reconnect runs (e.g. a cascading TCP
 *      failure during deploy), each handler reassigns `reconnectTimer`
 *      to a fresh `setTimeout` without clearing the prior handle. The
 *      stop path's `clearTimeout(reconnectTimer)` only cancels the
 *      most recent handle, so the earlier ones still fire and stack
 *      parallel SSE connections.
 *
 * The fix:
 *   - A module-level `stopped` flag, set by `stopPlaylistProxy` and
 *     cleared by `startPlaylistProxy`/`connectSSE`, gated by the
 *     'error' handler before it schedules a reconnect.
 *   - Each new `reconnectTimer` assignment clears the prior handle
 *     before overwriting it.
 *   - `reconnectDelay` backoff escalates only when a reconnect is
 *     actually scheduled (i.e. inside the guard), so a stopped proxy
 *     doesn't push the delay toward the ceiling for no reason.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// --- Mock EventSource that tracks instances and captures listeners ---

type EventHandler = (event: { data: string }) => void;

interface MockES {
  url: string;
  listeners: Map<string, EventHandler[]>;
  addEventListener: jest.Mock;
  close: jest.Mock;
  readyState: number;
}

const instances: MockES[] = [];

jest.mock('eventsource', () => ({
  EventSource: jest.fn().mockImplementation((url: string) => {
    const listeners = new Map<string, EventHandler[]>();
    const instance: MockES = {
      url,
      listeners,
      addEventListener: jest.fn((type: string, fn: EventHandler) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type)?.push(fn);
      }),
      close: jest.fn(),
      readyState: 1,
    };
    instances.push(instance);
    return instance;
  }),
}));

// drizzle-orm mock (needed by enrichPlaycuts even though it's not exercised here)
jest.mock('drizzle-orm', () => ({
  sql: Object.assign(jest.fn(), { raw: jest.fn() }),
  inArray: jest.fn(),
  isNotNull: jest.fn(),
  and: jest.fn(),
  eq: jest.fn(),
}));

// Suppress console output
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

// Import after mocks are in place. @wxyc/database is mapped to the
// shared mock by jest.unit.config.ts moduleNameMapper.
import {
  startPlaylistProxy,
  stopPlaylistProxy,
  resetState,
} from '../../../apps/backend/services/playlist-proxy.service';

/** Fire a named event on a mock EventSource instance. */
function fireEvent(es: MockES, type: string, data: unknown = {}): void {
  const handlers = es.listeners.get(type) ?? [];
  const event: { data: string } = { data: typeof data === 'string' ? data : JSON.stringify(data) };
  for (const handler of handlers) handler(event);
}

describe('playlist-proxy stopPlaylistProxy reconnect-timer hygiene', () => {
  beforeEach(() => {
    instances.length = 0;
    resetState();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('error fired after stopPlaylistProxy does not schedule a reconnect', () => {
    // Open the SSE connection and let it establish.
    startPlaylistProxy();
    expect(instances).toHaveLength(1);
    fireEvent(instances[0], 'init', []);

    // Operator stops the proxy.
    const stoppedEs = instances[0];
    stopPlaylistProxy();

    // An 'error' event is still queued in the EventLoop and fires
    // after the stop. Without the guard, this handler would schedule
    // a fresh reconnect timer that wakes up and reopens the SSE.
    fireEvent(stoppedEs, 'error');

    // Advance well past MAX_RECONNECT_DELAY (30 s) so any pending
    // reconnect would have fired.
    jest.advanceTimersByTime(60_000);

    // No fresh EventSource should have been constructed.
    expect(instances).toHaveLength(1);
  });

  test('queued reconnect timer is cleared by stopPlaylistProxy', () => {
    startPlaylistProxy();
    fireEvent(instances[0], 'init', []);
    fireEvent(instances[0], 'error');

    // Stop before the timer wakes up.
    stopPlaylistProxy();

    jest.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1);
  });

  test('stacked errors do not produce parallel reconnects after stop', () => {
    startPlaylistProxy();
    expect(instances).toHaveLength(1);
    fireEvent(instances[0], 'init', []);

    // Cascading errors before any reconnect timer fires.
    fireEvent(instances[0], 'error');
    fireEvent(instances[0], 'error');
    fireEvent(instances[0], 'error');

    // Stop before any timer wakes up.
    stopPlaylistProxy();

    jest.advanceTimersByTime(120_000);

    // No new EventSource instances; all queued timers were cancelled
    // (or, equivalently, gated out by the stopped flag).
    expect(instances).toHaveLength(1);
  });

  test('multiple stopPlaylistProxy calls in a row are idempotent', () => {
    startPlaylistProxy();
    fireEvent(instances[0], 'init', []);
    fireEvent(instances[0], 'error');

    expect(() => {
      stopPlaylistProxy();
      stopPlaylistProxy();
      stopPlaylistProxy();
    }).not.toThrow();

    jest.advanceTimersByTime(60_000);
    expect(instances).toHaveLength(1);
  });

  test('startPlaylistProxy after stop clears the stopped flag and reconnects on error', () => {
    startPlaylistProxy();
    fireEvent(instances[0], 'init', []);
    stopPlaylistProxy();

    // Re-start: stopped flag must be cleared so subsequent errors
    // schedule reconnects again.
    startPlaylistProxy();
    expect(instances).toHaveLength(2);
    fireEvent(instances[1], 'init', []);
    fireEvent(instances[1], 'error');

    // Advance past the 1 s base delay so the reconnect fires.
    jest.advanceTimersByTime(1_500);

    expect(instances).toHaveLength(3);
  });
});
