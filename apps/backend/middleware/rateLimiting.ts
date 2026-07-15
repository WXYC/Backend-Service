import rateLimit, { Options, MemoryStore } from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import { rateLimitKeyFromRequest } from './rate-limit-key';

// Environment-based configuration
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.USE_MOCK_SERVICES === 'true';
const enableRateLimitInTest = process.env.TEST_RATE_LIMITING === 'true';

// Configurable limits via environment variables (useful for testing)
const REQUEST_WINDOW_MS = parseInt(process.env.RATE_LIMIT_REQUEST_WINDOW_MS || '900000', 10); // 15 min default
const REQUEST_MAX = parseInt(process.env.RATE_LIMIT_REQUEST_MAX || '10', 10);

const PROXY_WINDOW_MS = parseInt(process.env.RATE_LIMIT_PROXY_WINDOW_MS || '60000', 10); // 60 seconds default
const PROXY_MAX = parseInt(process.env.RATE_LIMIT_PROXY_MAX || '120', 10);

// Shared stores so we can reset them in tests
const songRequestStore = new MemoryStore();
const proxyStore = new MemoryStore();

/**
 * Reset all rate limit stores. Only works in test environment.
 * Call this in beforeEach/afterEach to get a clean slate.
 */
export const resetRateLimitStores = (): void => {
  if (isTestEnv) {
    void songRequestStore.resetAll();
    void proxyStore.resetAll();
  }
};

// Pass-through middleware for test environments (when rate limiting is disabled)
const passThrough = (_req: Request, _res: Response, next: NextFunction) => next();

// Determine if rate limiting should be active
const shouldEnableRateLimiting = !isTestEnv || enableRateLimitInTest;

/**
 * Rate limiter for song request endpoint.
 * Limits requests per user ID.
 *
 * Configurable via environment:
 * - RATE_LIMIT_REQUEST_WINDOW_MS (default: 900000 = 15 minutes)
 * - RATE_LIMIT_REQUEST_MAX (default: 10)
 *
 * Disabled in test environment unless TEST_RATE_LIMITING=true
 */
export const songRequestRateLimit = shouldEnableRateLimiting
  ? rateLimit({
      windowMs: REQUEST_WINDOW_MS,
      max: REQUEST_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      store: songRequestStore,
      // Authenticated callers key on their user id; unauthenticated callers
      // key per-client-IP instead of a single shared bucket (BS#1127).
      keyGenerator: rateLimitKeyFromRequest,
      handler: (_req: Request, res: Response) => {
        res.status(429).json({
          message: 'Too many requests. Please wait before submitting more song requests.',
          retryAfter: Math.ceil(REQUEST_WINDOW_MS / 1000),
        });
      },
      validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false } as Partial<Options['validate']>,
    })
  : passThrough;

/**
 * Rate limiter for proxy endpoints (artwork, metadata, entity, Spotify).
 * Limits requests per user ID (from JWT auth).
 *
 * Configurable via environment:
 * - RATE_LIMIT_PROXY_WINDOW_MS (default: 60000 = 60 seconds)
 * - RATE_LIMIT_PROXY_MAX (default: 120)
 *
 * Disabled in test environment unless TEST_RATE_LIMITING=true
 */
export const proxyRateLimit = shouldEnableRateLimiting
  ? rateLimit({
      windowMs: PROXY_WINDOW_MS,
      max: PROXY_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      store: proxyStore,
      // Authenticated callers key on their user id; unauthenticated callers
      // key per-client-IP instead of a single shared bucket (BS#1127).
      keyGenerator: rateLimitKeyFromRequest,
      handler: (_req: Request, res: Response) => {
        res.status(429).json({
          message: 'Too many proxy requests. Please try again shortly.',
          retryAfter: Math.ceil(PROXY_WINDOW_MS / 1000),
        });
      },
      validate: { xForwardedForHeader: false } as Partial<Options['validate']>,
    })
  : passThrough;
