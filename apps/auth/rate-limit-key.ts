import type { Request } from 'express';

// Key on the nginx-set `X-Real-IP` (the same header better-auth's getIp
// consumes via `ipAddressHeaders: ['x-real-ip']` in
// shared/authentication/src/auth.definition.ts). XFF is client-controlled
// and must not influence rate-limit bucketing — see BS#774, BS#1048.
export const rateLimitKeyFromRequest = (req: Pick<Request, 'headers' | 'socket'>): string => {
  const raw = req.headers['x-real-ip'];
  const realIp = Array.isArray(raw) ? raw[0] : raw;
  if (typeof realIp === 'string' && realIp.length > 0) return realIp;
  return req.socket.remoteAddress ?? 'unknown';
};
