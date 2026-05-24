import type { Request } from 'express';

// Derive an express-rate-limit bucket key from the nginx-terminated
// `X-Real-IP` header. nginx is the only trusted source of client IP on
// `/auth/*` (BS#774); `X-Forwarded-For` is client-controlled and must not
// influence rate-limit keying. Mirrors better-auth's `ipAddressHeaders:
// ['x-real-ip']` config in shared/authentication/src/auth.definition.ts so
// the Express limiter and better-auth's internal limiter share one IP source.
//
// Reading from headers directly (instead of `req.ip`) also sidesteps
// express-rate-limit's `ERR_ERL_PERMISSIVE_TRUST_PROXY` validator, which
// fires when `app.set('trust proxy', true)` is combined with a default
// keyGenerator. See BS#1048.
export const rateLimitKeyFromRequest = (req: Pick<Request, 'headers' | 'socket'>): string => {
  const raw = req.headers['x-real-ip'];
  const realIp = Array.isArray(raw) ? raw[0] : raw;
  if (typeof realIp === 'string' && realIp.length > 0) return realIp;
  return req.socket.remoteAddress ?? 'unknown';
};
