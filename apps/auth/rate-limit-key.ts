import type { Request } from 'express';
import { createHash } from 'crypto';

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

// BS#2169. Both cookie name variants are needed: auth.definition.ts sets
// `advanced.defaultCookieAttributes.secure = NODE_ENV === 'production'`, and
// better-auth only prefixes the cookie name with `__Secure-` when `secure`
// is set. There is no `cookiePrefix` override anywhere in this repo, so the
// `better-auth` default prefix holds in both shapes. Check `__Secure-`
// first — a production request only ever carries that one.
const SESSION_COOKIE_NAMES = ['__Secure-better-auth.session_token', 'better-auth.session_token'] as const;

// Hashed, never raw — the cookie value and bearer token are live
// credentials, and express-rate-limit keys surface in logs and error paths.
// Truncated to 16 hex chars: enough to make an accidental cross-user
// collision astronomically unlikely for a rate-limit bucket key, without
// carrying the full digest around.
function hashCredential(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

// Minimal `Cookie`-header scan for the session cookie names above — not a
// full cookie parser. `apps/auth/app.ts` mounts no `cookie-parser` (BS#2169:
// adding one just to serve this one route's key function would parse
// cookies on every request to the auth service), so `req.cookies` is
// `undefined` and this has to read the raw header itself.
function extractSessionCookieValue(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const pairs = cookieHeader.split(';').map((pair) => pair.trim());
  for (const cookieName of SESSION_COOKIE_NAMES) {
    for (const pair of pairs) {
      const eqIndex = pair.indexOf('=');
      if (eqIndex === -1) continue;
      // Only the first `=` delimits the cookie name — the value itself may
      // legitimately contain `=` (e.g. a base64 signature segment), so this
      // must not split on every `=` in the header.
      if (pair.slice(0, eqIndex).trim() === cookieName) {
        return pair.slice(eqIndex + 1);
      }
    }
  }
  return undefined;
}

function extractBearerToken(authorizationHeader: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  if (typeof raw !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  return match?.[1];
}

// BS#2169. Identity-keyed fairness generator for GET /auth/get-session — see
// apps/auth/app.ts and the "Why the second limiter is not optional" section
// of plans/bs2169-get-session-limiter-key.md. Precedence:
//
//   1. `Authorization: Bearer <token>` — the device/iOS arm. Not optional:
//      `bearer()` is registered in auth.definition.ts and GET /get-session
//      is exercised with a bearer token by
//      tests/integration/device-authorization.spec.js. A cookie-only key
//      would leave that whole arm sharing the ~10 Cloudflare buckets this
//      fix exists to eliminate.
//   2. the session cookie — the browser / dj-site SSR arm.
//   3. a bare IP fallback (`ip:<x-real-ip or socket address>`), reusing
//      rateLimitKeyFromRequest's own resolution so a cookie-less/bearer-less
//      caller still gets bucketed.
//
// Mirrors the `user:`/`ip:` namespacing in
// apps/backend/middleware/rate-limit-key.ts (BS#1127) — deliberately NOT
// unified with it. That one keys on the verified `req.auth.id`; this one has
// no equivalent verified identity at keyGenerator time (see the mounted
// abuse-ceiling limiter in app.ts, which exists precisely because of that).
export const sessionRateLimitKeyFromRequest = (req: Pick<Request, 'headers' | 'socket'>): string => {
  const bearerToken = extractBearerToken(req.headers['authorization']);
  if (bearerToken) return `bearer:${hashCredential(bearerToken)}`;

  const cookieHeader = req.headers['cookie'];
  const sessionCookieValue = extractSessionCookieValue(typeof cookieHeader === 'string' ? cookieHeader : undefined);
  if (sessionCookieValue) return `session:${hashCredential(sessionCookieValue)}`;

  return `ip:${rateLimitKeyFromRequest(req)}`;
};
