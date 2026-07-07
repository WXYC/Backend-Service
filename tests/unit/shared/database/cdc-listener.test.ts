/**
 * Unit tests for shared/database/src/cdc-listener.ts (BS#1014).
 *
 * Pins the new liveness machinery added in this PR:
 *   - `onCdcConnectionStateChange` dispatches `true` on initial subscribe via
 *     the postgres-js `onlisten` hook (also fires on auto-reconnect).
 *   - Duplicate transitions are suppressed (a healthy probe doesn't churn
 *     callbacks every interval).
 *   - `enableLivenessProbe` LISTENs on `cdc_health`, NOTIFYs at each tick,
 *     dispatches `connected=true` on echo, dispatches `connected=false` when
 *     the in-flight probe exceeds `echoTimeoutMs`.
 *   - A NOTIFY failure surfaces `connected=false` immediately (no wait).
 *   - `stopCdcListener` clears the probe timer + module-level state.
 *
 * Postgres-js is jest.mock'd; the cdc-listener module is `import()`'d fresh
 * per test via `jest.resetModules()` so the module-level singletons don't
 * leak across cases.
 */

// Mock factory: each test injects a fresh `mockSql` via mockImplementation
// before the cdc-listener module is loaded.
const postgresFactory = jest.fn();
jest.mock('postgres', () => ({
  __esModule: true,
  default: (...args: unknown[]) => postgresFactory(...args),
}));

type CdcListenerModule = typeof import('../../../../shared/database/src/cdc-listener');

interface MockSql {
  listen: jest.Mock;
  notify: jest.Mock;
  end: jest.Mock;
}

interface MockHandles {
  sql: MockSql;
  cdcOnNotify?: (payload: string) => void;
  cdcOnListen?: () => void;
  healthOnNotify?: (payload: string) => void;
  cdcOversizedOnNotify?: (payload: string) => void;
  cdcErrorOnNotify?: (payload: string) => void;
}

function makeMockSql(): MockHandles {
  const handles: MockHandles = { sql: {} as MockSql };
  handles.sql = {
    listen: jest.fn((channel: string, onnotify: (p: string) => void, onlisten?: () => void) => {
      if (channel === 'cdc') {
        handles.cdcOnNotify = onnotify;
        handles.cdcOnListen = onlisten;
        if (onlisten) onlisten();
      } else if (channel === 'cdc_health') {
        handles.healthOnNotify = onnotify;
      } else if (channel === 'cdc_oversized') {
        handles.cdcOversizedOnNotify = onnotify;
      } else if (channel === 'cdc_error') {
        handles.cdcErrorOnNotify = onnotify;
      }
      return Promise.resolve({ unlisten: jest.fn(() => Promise.resolve()) });
    }),
    notify: jest.fn(() => Promise.resolve()),
    end: jest.fn(() => Promise.resolve()),
  };
  return handles;
}

describe('cdc-listener liveness (BS#1014)', () => {
  let cdc: CdcListenerModule;
  let handles: MockHandles;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.resetModules();
    handles = makeMockSql();
    postgresFactory.mockReset();
    postgresFactory.mockReturnValue(handles.sql);
    cdc = await import('../../../../shared/database/src/cdc-listener');
  });

  afterEach(async () => {
    // Always stop cleanly so the timer doesn't leak into the next test.
    await cdc.stopCdcListener();
    jest.useRealTimers();
  });

  describe('onCdcConnectionStateChange (onlisten hook)', () => {
    it('dispatches true on initial subscribe via the postgres-js onlisten callback', async () => {
      const cb = jest.fn();
      cdc.onCdcConnectionStateChange(cb);
      await cdc.startCdcListener();
      expect(cb).toHaveBeenCalledWith(true);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('also dispatches when the onlisten hook fires again (postgres-js auto-reconnect)', async () => {
      const cb = jest.fn();
      cdc.onCdcConnectionStateChange(cb);
      await cdc.startCdcListener();
      cb.mockClear();
      // Simulate the listener falsifying then re-listening — only the
      // false→true transition should dispatch.
      await cdc.enableLivenessProbe({ probeIntervalMs: 1000, echoTimeoutMs: 100 });
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      // Probe timed out → false
      expect(cb).toHaveBeenLastCalledWith(false);
      cb.mockClear();
      // Postgres-js auto-reconnect would fire onlisten again
      handles.cdcOnListen?.();
      expect(cb).toHaveBeenCalledWith(true);
    });

    it('suppresses duplicate same-state dispatches', async () => {
      const cb = jest.fn();
      cdc.onCdcConnectionStateChange(cb);
      await cdc.startCdcListener(); // -> true (1st)
      handles.cdcOnListen?.(); // -> true again, should be suppressed
      handles.cdcOnListen?.(); // -> true again, should be suppressed
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('isolates state-callback errors from sibling callbacks', async () => {
      const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const bad = jest.fn(() => {
        throw new Error('boom');
      });
      const good = jest.fn();
      cdc.onCdcConnectionStateChange(bad);
      cdc.onCdcConnectionStateChange(good);
      await cdc.startCdcListener();
      expect(bad).toHaveBeenCalledWith(true);
      expect(good).toHaveBeenCalledWith(true);
      expect(consoleErr).toHaveBeenCalledWith('[cdc-listener] State callback error:', expect.any(Error));
      consoleErr.mockRestore();
    });
  });

  describe('enableLivenessProbe', () => {
    it('throws when called before startCdcListener', async () => {
      await expect(cdc.enableLivenessProbe()).rejects.toThrow(
        '[cdc-listener] enableLivenessProbe called before startCdcListener'
      );
    });

    it('registers a LISTEN on cdc_health and starts an interval timer', async () => {
      await cdc.startCdcListener();
      await cdc.enableLivenessProbe({ probeIntervalMs: 5000, echoTimeoutMs: 12_000 });
      // Four LISTENs total: cdc + cdc_oversized + cdc_error (from startCdcListener,
      // post-BS#1120) + cdc_health (added by enableLivenessProbe).
      const channels = handles.sql.listen.mock.calls.map((c) => c[0]);
      expect(channels).toEqual(['cdc', 'cdc_oversized', 'cdc_error', 'cdc_health']);
    });

    it('no-ops on second call (warns once)', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      await cdc.startCdcListener();
      await cdc.enableLivenessProbe({ probeIntervalMs: 5000 });
      await cdc.enableLivenessProbe({ probeIntervalMs: 5000 });
      expect(warn).toHaveBeenCalledWith('[cdc-listener] Liveness probe already enabled');
      warn.mockRestore();
    });

    it('sends NOTIFY on cdc_health each interval', async () => {
      await cdc.startCdcListener();
      await cdc.enableLivenessProbe({ probeIntervalMs: 1000, echoTimeoutMs: 5000 });
      handles.sql.notify.mockClear();
      jest.advanceTimersByTime(1000);
      // Let the queued promise tick run
      await Promise.resolve();
      expect(handles.sql.notify).toHaveBeenCalledTimes(1);
      expect(handles.sql.notify.mock.calls[0][0]).toBe('cdc_health');
      expect(typeof handles.sql.notify.mock.calls[0][1]).toBe('string');
    });

    it('dispatches connected=true when its own echo arrives', async () => {
      const cb = jest.fn();
      cdc.onCdcConnectionStateChange(cb);
      await cdc.startCdcListener(); // -> true (initial)
      await cdc.enableLivenessProbe({ probeIntervalMs: 1000, echoTimeoutMs: 5000 });
      cb.mockClear();

      // Flip to false first so the echo→true transition is observable past
      // the duplicate-suppression filter. Use a one-shot NOTIFY rejection
      // (immediate false dispatch) rather than the echo-timeout path,
      // because the timeout now clears `outstandingProbeToken` (BS#1116) —
      // making a late-arriving echo intentionally a no-op.
      handles.sql.notify.mockRejectedValueOnce(new Error('pool dead'));
      const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(cb).toHaveBeenLastCalledWith(false);
      consoleErr.mockRestore();
      cb.mockClear();

      // Next tick: NOTIFY succeeds, token outstanding
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
      const token = handles.sql.notify.mock.calls.at(-1)?.[1] as string;
      expect(typeof token).toBe('string');

      // Echo of the live outstanding token flips state back to true
      handles.healthOnNotify?.(token);
      expect(cb).toHaveBeenCalledWith(true);
    });

    it('ignores echoes whose payload does not match the outstanding token', async () => {
      const cb = jest.fn();
      cdc.onCdcConnectionStateChange(cb);
      await cdc.startCdcListener();
      await cdc.enableLivenessProbe({ probeIntervalMs: 1000, echoTimeoutMs: 5000 });

      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();

      // Force false first so a true-dispatch from a foreign echo would be observable
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      cb.mockClear();

      handles.healthOnNotify?.('not-my-token');
      expect(cb).not.toHaveBeenCalled();
    });

    it('dispatches connected=false when probe exceeds echoTimeoutMs without an echo', async () => {
      const cb = jest.fn();
      cdc.onCdcConnectionStateChange(cb);
      await cdc.startCdcListener();
      await cdc.enableLivenessProbe({ probeIntervalMs: 1000, echoTimeoutMs: 2000 });
      cb.mockClear();

      // Tick 1: probe sent at t=1000
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(cb).not.toHaveBeenCalled();

      // Tick 2 (t=2000): probe is 1000ms old, still under 2000ms timeout
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(cb).not.toHaveBeenCalled();

      // Tick 3 (t=3000): probe is 2000ms old, exceeds timeout → false
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(cb).toHaveBeenCalledWith(false);
    });

    it('continues issuing fresh probes after an echo timeout (wedge recovery, BS#1116)', async () => {
      // Regression: after the first echo timeout, the probe state must be
      // cleared so the next interval tick re-arms. Otherwise the early-return
      // on `outstandingProbeToken !== null` kills probing for the rest of the
      // process's life — even after postgres-js auto-reconnect.
      const cb = jest.fn();
      cdc.onCdcConnectionStateChange(cb);
      await cdc.startCdcListener();
      await cdc.enableLivenessProbe({ probeIntervalMs: 1000, echoTimeoutMs: 2000 });
      cb.mockClear();
      handles.sql.notify.mockClear();

      // Tick 1 (t=1000): first probe NOTIFY
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(handles.sql.notify).toHaveBeenCalledTimes(1);

      // Tick 3 (t=3000): probe is 2000ms old → exceeds echoTimeoutMs → false
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
      expect(cb).toHaveBeenCalledWith(false);

      // Simulate postgres-js auto-reconnect flipping state back to true so
      // the next failure is observable as a fresh false transition.
      handles.cdcOnListen?.();
      expect(cb).toHaveBeenLastCalledWith(true);
      cb.mockClear();
      handles.sql.notify.mockClear();

      // Tick 4 (t=4000): probe loop must have re-armed → a fresh NOTIFY goes out
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(handles.sql.notify).toHaveBeenCalledTimes(1);

      // Tick 6 (t=6000): the fresh probe is 2000ms old → false again
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
      expect(cb).toHaveBeenCalledWith(false);
    });

    it('dispatches connected=false immediately if NOTIFY itself rejects', async () => {
      const cb = jest.fn();
      cdc.onCdcConnectionStateChange(cb);
      await cdc.startCdcListener();
      await cdc.enableLivenessProbe({ probeIntervalMs: 1000, echoTimeoutMs: 30_000 });
      cb.mockClear();
      const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      handles.sql.notify.mockRejectedValueOnce(new Error('pool dead'));

      jest.advanceTimersByTime(1000);
      // Let the failed promise reject + propagate
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(cb).toHaveBeenCalledWith(false);
      expect(consoleErr).toHaveBeenCalledWith('[cdc-listener] Liveness probe NOTIFY failed:', expect.any(Error));
      consoleErr.mockRestore();
    });
  });

  describe('stopCdcListener', () => {
    it('clears the liveness probe timer and resets module state', async () => {
      const cb = jest.fn();
      cdc.onCdcConnectionStateChange(cb);
      await cdc.startCdcListener();
      await cdc.enableLivenessProbe({ probeIntervalMs: 1000, echoTimeoutMs: 2000 });
      cb.mockClear();
      handles.sql.notify.mockClear();

      await cdc.stopCdcListener();

      // After stop, advancing time should not produce further NOTIFY calls
      // or state callbacks.
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
      expect(handles.sql.notify).not.toHaveBeenCalled();
      expect(cb).not.toHaveBeenCalled();
      expect(handles.sql.end).toHaveBeenCalledTimes(1);
    });
  });
});

describe('cdc-listener fallback channels (BS#1120)', () => {
  let cdc: CdcListenerModule;
  let handles: MockHandles;

  beforeEach(async () => {
    jest.resetModules();
    handles = makeMockSql();
    postgresFactory.mockReset();
    postgresFactory.mockReturnValue(handles.sql);
    cdc = await import('../../../../shared/database/src/cdc-listener');
  });

  afterEach(async () => {
    await cdc.stopCdcListener();
  });

  describe('subscription', () => {
    it('subscribes to cdc, cdc_oversized, and cdc_error on startCdcListener', async () => {
      await cdc.startCdcListener();
      const channels = handles.sql.listen.mock.calls.map((c) => c[0]);
      expect(channels).toEqual(['cdc', 'cdc_oversized', 'cdc_error']);
    });
  });

  describe('onCdcOversizedEvent', () => {
    it('dispatches a parsed CdcOversizedEvent when cdc_oversized fires', async () => {
      const cb = jest.fn();
      cdc.onCdcOversizedEvent(cb);
      await cdc.startCdcListener();

      const payload = {
        table: 'flowsheet',
        schema: 'wxyc_schema',
        action: 'UPDATE',
        primary_key: '42',
        payload_bytes: 8500,
        timestamp: 1_700_000_000_000,
        reason: 'payload_too_large',
      };
      handles.cdcOversizedOnNotify?.(JSON.stringify(payload));

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(payload);
    });

    it('invokes all registered callbacks on a single notification', async () => {
      const a = jest.fn();
      const b = jest.fn();
      cdc.onCdcOversizedEvent(a);
      cdc.onCdcOversizedEvent(b);
      await cdc.startCdcListener();

      handles.cdcOversizedOnNotify?.(
        JSON.stringify({
          table: 'flowsheet',
          schema: 'wxyc_schema',
          action: 'INSERT',
          primary_key: null,
          payload_bytes: 9001,
          timestamp: 1_700_000_000_000,
          reason: 'payload_too_large',
        })
      );

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('isolates a throwing callback so siblings still run', async () => {
      const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const bad = jest.fn(() => {
        throw new Error('boom');
      });
      const good = jest.fn();
      cdc.onCdcOversizedEvent(bad);
      cdc.onCdcOversizedEvent(good);
      await cdc.startCdcListener();

      handles.cdcOversizedOnNotify?.(
        JSON.stringify({
          table: 'flowsheet',
          schema: 'wxyc_schema',
          action: 'UPDATE',
          primary_key: '1',
          payload_bytes: 8000,
          timestamp: 1_700_000_000_000,
          reason: 'payload_too_large',
        })
      );

      expect(bad).toHaveBeenCalled();
      expect(good).toHaveBeenCalled();
      expect(consoleErr).toHaveBeenCalledWith('[cdc-listener] Oversized callback error:', expect.any(Error));
      consoleErr.mockRestore();
    });

    it('logs and does not throw on a malformed payload', async () => {
      const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const cb = jest.fn();
      cdc.onCdcOversizedEvent(cb);
      await cdc.startCdcListener();

      expect(() => handles.cdcOversizedOnNotify?.('not-json')).not.toThrow();
      expect(cb).not.toHaveBeenCalled();
      expect(consoleErr).toHaveBeenCalledWith(
        '[cdc-listener] Failed to parse cdc_oversized payload:',
        expect.any(Error)
      );
      consoleErr.mockRestore();
    });
  });

  describe('onCdcErrorEvent', () => {
    it('dispatches a parsed CdcErrorEvent when cdc_error fires', async () => {
      const cb = jest.fn();
      cdc.onCdcErrorEvent(cb);
      await cdc.startCdcListener();

      const payload = {
        table: 'flowsheet',
        schema: 'wxyc_schema',
        action: 'INSERT',
        sqlstate: '22023',
        sqlerrm: 'invalid_parameter_value',
        timestamp: 1_700_000_000_000,
        reason: 'trigger_exception',
      };
      handles.cdcErrorOnNotify?.(JSON.stringify(payload));

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith(payload);
    });

    it('isolates a throwing callback so siblings still run', async () => {
      const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const bad = jest.fn(() => {
        throw new Error('boom');
      });
      const good = jest.fn();
      cdc.onCdcErrorEvent(bad);
      cdc.onCdcErrorEvent(good);
      await cdc.startCdcListener();

      handles.cdcErrorOnNotify?.(
        JSON.stringify({
          table: 'flowsheet',
          schema: 'wxyc_schema',
          action: 'UPDATE',
          sqlstate: 'XX000',
          sqlerrm: 'internal_error',
          timestamp: 1_700_000_000_000,
          reason: 'trigger_exception',
        })
      );

      expect(bad).toHaveBeenCalled();
      expect(good).toHaveBeenCalled();
      expect(consoleErr).toHaveBeenCalledWith('[cdc-listener] Error callback error:', expect.any(Error));
      consoleErr.mockRestore();
    });

    it('logs and does not throw on a malformed payload', async () => {
      const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const cb = jest.fn();
      cdc.onCdcErrorEvent(cb);
      await cdc.startCdcListener();

      expect(() => handles.cdcErrorOnNotify?.('not-json')).not.toThrow();
      expect(cb).not.toHaveBeenCalled();
      expect(consoleErr).toHaveBeenCalledWith('[cdc-listener] Failed to parse cdc_error payload:', expect.any(Error));
      consoleErr.mockRestore();
    });
  });

  describe('stopCdcListener', () => {
    it('clears oversized + error callback arrays so a re-start does not double-fire', async () => {
      const oversized = jest.fn();
      const errored = jest.fn();
      cdc.onCdcOversizedEvent(oversized);
      cdc.onCdcErrorEvent(errored);
      await cdc.startCdcListener();
      await cdc.stopCdcListener();

      // Fresh start should see empty callback arrays — no callbacks fire.
      handles = makeMockSql();
      postgresFactory.mockReturnValue(handles.sql);
      await cdc.startCdcListener();
      handles.cdcOversizedOnNotify?.(
        JSON.stringify({
          table: 't',
          schema: 's',
          action: 'INSERT',
          primary_key: null,
          payload_bytes: 9000,
          timestamp: 0,
          reason: 'payload_too_large',
        })
      );
      handles.cdcErrorOnNotify?.(
        JSON.stringify({
          table: 't',
          schema: 's',
          action: 'INSERT',
          sqlstate: 'XX000',
          sqlerrm: 'x',
          timestamp: 0,
          reason: 'trigger_exception',
        })
      );

      expect(oversized).not.toHaveBeenCalled();
      expect(errored).not.toHaveBeenCalled();
    });
  });
});
