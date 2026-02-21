jest.mock('node-ssh', () => {
  const mockSSH = {
    isConnected: jest.fn().mockReturnValue(false),
    connect: jest.fn().mockResolvedValue(undefined),
    dispose: jest.fn(),
  };
  return { NodeSSH: jest.fn(() => mockSSH) };
});

import { MirrorSQL } from '../../../../apps/backend/middleware/legacy/sql.mirror';

describe('MirrorSQL SSH timeout stacking', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Reset the singleton between tests
    (MirrorSQL as any)._instance = null;
    (MirrorSQL as any)._ssh = null;
    (MirrorSQL as any)._timeoutHandle = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should only have one active timeout after multiple sshInstance() calls', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    await MirrorSQL.sshInstance();
    await MirrorSQL.sshInstance();
    await MirrorSQL.sshInstance();

    const timeoutCalls = setTimeoutSpy.mock.calls.filter(
      ([, ms]) => ms === 5 * 60 * 1000
    );

    expect(timeoutCalls).toHaveLength(3);
    // After 3 calls, the first 2 timeouts should have been cleared
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('should not dispose SSH if timeout was superseded by a newer call', async () => {
    const { NodeSSH } = jest.requireMock('node-ssh');
    const mockSSH = new NodeSSH();
    mockSSH.isConnected.mockReturnValue(true);

    await MirrorSQL.sshInstance();
    // Advance partway — not enough to trigger
    jest.advanceTimersByTime(4 * 60 * 1000);

    await MirrorSQL.sshInstance();
    // Advance past original 5 min mark — old timeout should have been cleared
    jest.advanceTimersByTime(2 * 60 * 1000);

    expect(mockSSH.dispose).not.toHaveBeenCalled();

    // Advance to trigger the second (active) timeout
    jest.advanceTimersByTime(3 * 60 * 1000);
    expect(mockSSH.dispose).toHaveBeenCalledTimes(1);
  });
});
