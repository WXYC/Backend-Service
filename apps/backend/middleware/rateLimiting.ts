import rateLimit, { Options, MemoryStore } from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';

// Environment-based configuration
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.USE_MOCK_SERVICES === 'true';
const enableRateLimitInTest = process.env.TEST_RATE_LIMITING === 'true';

// Configurable limits via environment variables (useful for testing)
const REGISTRATION_WINDOW_MS = parseInt(process.env.RATE_LIMIT_REGISTRATION_WINDOW_MS || '3600000', 10); // 1 hour default
const REGISTRATION_MAX = parseInt(process.env.RATE_LIMIT_REGISTRATION_MAX || '5', 10);
const REQUEST_WINDOW_MS = parseInt(process.env.RATE_LIMIT_REQUEST_WINDOW_MS || '900000', 10); // 15 min default
const REQUEST_MAX = parseInt(process.env.RATE_LIMIT_REQUEST_MAX || '10', 10);

// Shared stores so we can reset them in tests
const registrationStore = new MemoryStore();
const songRequestStore = new MemoryStore();

/**
 * Reset all rate limit stores. Only works in test environment.
 * Call this in beforeEach/afterEach to get a clean slate.
 */
export const resetRateLimitStores = (): void => {
  if (isTestEnv) {
    registrationStore.resetAll();
    songRequestStore.resetAll();
  }
};

// Pass-through middleware for test environments (when rate limiting is disabled)
const passThrough = (_req: Request, _res: Response, next: NextFunction) => next();

// Determine if rate limiting should be active
const shouldEnableRateLimiting = !isTestEnv || enableRateLimitInTest;

/**
 * Rate limiter for device registration endpoint.
 * Limits registrations per IP address.
 *
 * Configurable via environment:
 * - RATE_LIMIT_REGISTRATION_WINDOW_MS (default: 3600000 = 1 hour)
 * - RATE_LIMIT_REGISTRATION_MAX (default: 5)
 *
 * Disabled in test environment unless TEST_RATE_LIMITING=true
 */
export const registrationRateLimit = shouldEnableRateLimiting
  ? rateLimit({
      windowMs: REGISTRATION_WINDOW_MS,
      max: REGISTRATION_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      store: registrationStore,
      handler: (_req: Request, res: Response) => {
        res.status(429).json({
          message: 'Too many registration attempts. Please try again later.',
          retryAfter: Math.ceil(REGISTRATION_WINDOW_MS / 1000),
        });
      },
    })
  : passThrough;

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
      keyGenerator: (req: Request) => {
        // Use user ID if available (set by anonymousAuth middleware)
        if (req.user?.id) {
          return req.user.id;
        }
        // Fall back to 'unknown' - this shouldn't happen since auth middleware runs first
        return 'unknown';
      },
      handler: (_req: Request, res: Response) => {
        res.status(429).json({
          message: 'Too many requests. Please wait before submitting more song requests.',
          retryAfter: Math.ceil(REQUEST_WINDOW_MS / 1000),
        });
      },
      // Skip validation for keyGenerator since we're using device ID, not IP
      validate: { xForwardedForHeader: false } as Partial<Options['validate']>,
    })
  : passThrough;
