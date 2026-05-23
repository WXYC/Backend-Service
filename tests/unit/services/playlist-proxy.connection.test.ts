/**
 * Tests for playlist proxy SSE connection lifecycle.
 *
 * These tests verify that the proxy manages its EventSource connection
 * correctly — specifically that it does not tear down healthy connections
 * due to an overly aggressive heartbeat timeout.
 *
 * Background: tubafrenzy sends `:heartbeat` SSE comments every 30 seconds.
 * The EventSource API silently consumes SSE comments without dispatching
 * events, so any application-level heartbeat timer that resets only on
 * named events (init, created, updated, deleted) will never see the
 * heartbeat comments and will conclude the connection is dead.
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

// drizzle-orm mock (needed by enrichPlaycuts)
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
import { startPlaylistProxy, resetState } from '../../../apps/backend/services/playlist-proxy.service';

/** Fire a named event on a mock EventSource instance. */
function fireEvent(es: MockES, type: string, data: unknown = {}): void {
  const handlers = es.listeners.get(type) ?? [];
  const event: { data: string } = { data: typeof data === 'string' ? data : JSON.stringify(data) };
  for (const handler of handlers) handler(event);
}

describe('playlist-proxy SSE connection stability', () => {
  beforeEach(() => {
    instances.length = 0;
    resetState();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('does not reconnect when the connection is healthy and has no errors', () => {
    // Tubafrenzy sends :heartbeat SSE comments every 30 seconds.
    // The proxy's heartbeat timer (60 s) should not fire when the
    // underlying connection is still alive. Today it does, because
    // SSE comments are invisible to addEventListener — only named
    // events (init, created, …) reset the timer.

    startPlaylistProxy();
    expect(instances).toHaveLength(1);

    // Server delivers the init payload — connection is established.
    fireEvent(instances[0], 'init', []);

    // Advance well past the 60-second heartbeat timeout.
    // No errors have occurred; the connection is perfectly healthy.
    jest.advanceTimersByTime(90_000);

    // A healthy, error-free connection should not be torn down.
    expect(instances).toHaveLength(1);
  });
});
