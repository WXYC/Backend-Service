/**
 * Unit tests for jobs/concerts-artist-resolver error-sink.ts (BS#1760).
 *
 * `safeNotifyError` is the shared onError-sink guard used by the new
 * sync.ts and support.ts orchestrator loops. It mirrors orchestrate.ts's
 * private `safeNotifyError`/`safeStringifyThrown` pair (pinned by
 * orchestrate.test.ts's "onError throws" / "onError rejects" cases) —
 * this suite pins the same contract for the shared copy.
 */
import { safeNotifyError, safeStringifyThrown } from '../../../../jobs/concerts-artist-resolver/error-sink';

describe('safeStringifyThrown', () => {
  it('returns an Error instance message', () => {
    expect(safeStringifyThrown(new Error('boom'))).toBe('boom');
  });

  it('stringifies a non-Error thrown value', () => {
    expect(safeStringifyThrown('plain string throw')).toBe('plain string throw');
  });

  it('falls back to a constant when String() itself throws', () => {
    const pathological = {
      toString() {
        throw new Error('toString explodes');
      },
      [Symbol.toPrimitive]() {
        throw new Error('toPrimitive explodes too');
      },
    };
    expect(safeStringifyThrown(pathological)).toBe('<unrepresentable sink error>');
  });
});

describe('safeNotifyError', () => {
  it('awaits a synchronous onError call', async () => {
    const onError = jest.fn();
    await safeNotifyError(onError, { id: 1 }, new Error('boom'), 'test-prefix');
    expect(onError).toHaveBeenCalledWith({ id: 1 }, expect.any(Error));
  });

  it('swallows a synchronous throw from onError without re-raising', async () => {
    const onError = jest.fn(() => {
      throw new Error('EPIPE: stdout closed');
    });
    await expect(safeNotifyError(onError, { id: 2 }, new Error('boom'), 'test-prefix')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('swallows an async rejection from onError without re-raising or unhandledRejection', async () => {
    const onError = jest.fn(() => Promise.reject(new Error('slack: 429 rate limited')));
    await expect(safeNotifyError(onError, { id: 3 }, new Error('boom'), 'test-prefix')).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('writes a single stderr line naming the prefix when the sink fails', async () => {
    const writeSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const onError = jest.fn(() => {
      throw new Error('sink broke');
    });

    await safeNotifyError(onError, { id: 4 }, new Error('boom'), 'my-prefix');

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toContain('my-prefix');
    expect(writeSpy.mock.calls[0][0]).toContain('sink broke');
    writeSpy.mockRestore();
  });
});
