import { Request } from 'express';

let capturedConfigs: Record<string, unknown>[] = [];

jest.mock('express-rate-limit', () => {
  const { MemoryStore } = jest.requireActual<typeof import('express-rate-limit')>('express-rate-limit');
  const mockRateLimit = (config: Record<string, unknown>) => {
    capturedConfigs.push(config);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  };
  mockRateLimit.MemoryStore = MemoryStore;
  return { __esModule: true, default: mockRateLimit, MemoryStore };
});

const makeReq = (overrides: {
  auth?: { id?: string };
  headers?: Record<string, string | string[] | undefined>;
  remoteAddress?: string | undefined;
}) =>
  ({
    auth: overrides.auth,
    headers: overrides.headers ?? {},
    socket: { remoteAddress: overrides.remoteAddress },
  }) as unknown as Request;

describe('rate limiter keyGenerators', () => {
  let keyGenerators: ((req: Request) => string)[];

  beforeAll(async () => {
    capturedConfigs = [];
    // Force rate limiting to be active so the configs are captured
    process.env.TEST_RATE_LIMITING = 'true';
    // Re-import after mock is in place
    jest.resetModules();

    // Re-apply the mock after resetModules
    jest.mock('express-rate-limit', () => {
      const { MemoryStore } = jest.requireActual<typeof import('express-rate-limit')>('express-rate-limit');
      const mockRateLimit = (config: Record<string, unknown>) => {
        capturedConfigs.push(config);
        return (_req: unknown, _res: unknown, next: () => void) => next();
      };
      mockRateLimit.MemoryStore = MemoryStore;
      return { __esModule: true, default: mockRateLimit, MemoryStore };
    });

    await import('../../../apps/backend/middleware/rateLimiting');

    keyGenerators = capturedConfigs
      .map((c) => c.keyGenerator)
      .filter((k): k is (req: Request) => string => typeof k === 'function');
  });

  afterAll(() => {
    delete process.env.TEST_RATE_LIMITING;
  });

  it('wires a keyGenerator into both the song-request and proxy limiters', () => {
    expect(keyGenerators.length).toBe(2);
  });

  // Both limiters share the same per-request key policy (BS#1127), so assert
  // the behaviour against each captured keyGenerator.
  describe.each([[0], [1]])('keyGenerator #%i', (idx) => {
    it('keys an authenticated caller on their namespaced user id', () => {
      const req = makeReq({ auth: { id: 'user-123' }, headers: { 'x-real-ip': '203.0.113.7' } });
      expect(keyGenerators[idx](req)).toBe('user:user-123');
    });

    it('gives two different unauthenticated IPs independent buckets', () => {
      const keyA = keyGenerators[idx](makeReq({ headers: { 'x-real-ip': '203.0.113.7' } }));
      const keyB = keyGenerators[idx](makeReq({ headers: { 'x-real-ip': '198.51.100.2' } }));
      expect(keyA).toBe('ip:203.0.113.7');
      expect(keyB).toBe('ip:198.51.100.2');
      expect(keyA).not.toBe(keyB);
    });

    it('never returns the shared literal "unknown" bucket for an unauthenticated caller', () => {
      const key = keyGenerators[idx](makeReq({ headers: { 'x-real-ip': '192.0.2.9' } }));
      expect(key).not.toBe('unknown');
      expect(key).toBe('ip:192.0.2.9');
    });
  });
});
