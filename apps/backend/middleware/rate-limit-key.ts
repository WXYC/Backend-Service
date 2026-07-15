import type { Request } from 'express';

// Namespace prefixes keep the authenticated-user key space and the
// unauthenticated per-IP key space from colliding, so a caller cannot set
// their user id to a victim's IP and poison that bucket (BS#1127).
const USER_KEY_PREFIX = 'user:';
const IP_KEY_PREFIX = 'ip:';

// Mirrors apps/auth/rate-limit-key.ts: key on the nginx-set `x-real-ip`
// header, never `req.ip`. Under `trust proxy: true` (apps/backend/app.ts)
// `req.ip` reads the client-controlled X-Forwarded-For, which must not
// influence rate-limit bucketing — see BS#774, BS#1048.
const clientIpFromRequest = (req: Pick<Request, 'headers' | 'socket'>): string => {
  const raw = req.headers['x-real-ip'];
  const realIp = Array.isArray(raw) ? raw[0] : raw;
  if (typeof realIp === 'string' && realIp.length > 0) return realIp;
  return req.socket.remoteAddress ?? 'unknown';
};

/**
 * Compute the rate-limit bucket key for a request.
 *
 * Authenticated callers key on their user id (namespaced `user:`).
 * Unauthenticated callers key on their client IP (namespaced `ip:`) instead
 * of a single shared `'unknown'` bucket, so one anonymous client's traffic
 * can no longer exhaust the limit for every other unauthenticated caller
 * (BS#1127).
 */
export const rateLimitKeyFromRequest = (req: Request): string => {
  if (req.auth?.id) {
    return `${USER_KEY_PREFIX}${req.auth.id}`;
  }
  return `${IP_KEY_PREFIX}${clientIpFromRequest(req)}`;
};
