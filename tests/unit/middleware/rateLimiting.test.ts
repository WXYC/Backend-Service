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

describe('songRequestRateLimit keyGenerator', () => {
  let keyGenerator: (req: Request) => string;

  beforeAll(async () => {
    capturedConfigs = [];
    // Force rate limiting to be active so the config is captured
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

    const songRequestConfig = capturedConfigs.find(
      (c) => typeof c.keyGenerator === 'function'
    );
    expect(songRequestConfig).toBeDefined();
    keyGenerator = songRequestConfig!.keyGenerator as (req: Request) => string;
  });

  afterAll(() => {
    delete process.env.TEST_RATE_LIMITING;
  });

  it('returns user ID when req.user.id is set', () => {
    const req = { user: { id: 'user-123' }, ip: '10.0.0.1' } as unknown as Request;
    expect(keyGenerator(req)).toBe('user-123');
  });

  it('returns req.ip when req.user is undefined', () => {
    const req = { user: undefined, ip: '192.168.1.42' } as unknown as Request;
    expect(keyGenerator(req)).toBe('192.168.1.42');
  });

  it('returns req.ip when req.user.id is missing', () => {
    const req = { user: {}, ip: '10.0.0.5' } as unknown as Request;
    expect(keyGenerator(req)).toBe('10.0.0.5');
  });

  it('returns "unknown" only when both req.user.id and req.ip are unavailable', () => {
    const req = { user: undefined, ip: undefined } as unknown as Request;
    expect(keyGenerator(req)).toBe('unknown');
  });
});
