import * as Sentry from '@sentry/node';
import type { NextFunction, Request, Response } from 'express';
import type { Options, RateLimitExceededEventHandler } from 'express-rate-limit';
import { createBufferedMetricEmitter } from '@wxyc/observability/metrics';
import { sessionRateLimitKeyFromRequest } from './rate-limit-key';

/**
 * Observability for the two rate limiters mounted on GET /auth/get-session
 * (see apps/auth/app.ts) — BS#2169.
 *
 * Namespace/metric-name/dimension wiring lives here; the buffered CloudWatch
 * machinery itself lives in `@wxyc/observability/metrics`, extracted from
 * `apps/backend/middleware/responseMetrics.ts` (BS#845) and
 * `apps/backend/services/sse/sse-metrics.ts` so both containers share one
 * implementation.
 *
 * Dimensioned-only for now (Limiter / KeyKind / Route) — no dimensionless
 * companion. AC4 ("GET /auth 429 rate under 0.1% over 7 days post-deploy")
 * is verified by the nginx `zcat` grep, not an alarm, so the companion has
 * no consumer yet. Ships once a wxyc-canary alarm on
 * `WXYC/AuthService RateLimited` lands — see `WXYC/CLAUDE.md`'s CloudWatch
 * Metric & Alarm Conventions and the `MutationClientError` /
 * wxyc-canary#17 precedent this mirrors.
 */

const NAMESPACE = 'WXYC/AuthService';
const METRIC_NAME = 'RateLimited';
const ROUTE = '/auth/get-session';

export type LimiterName = 'ip' | 'identity';
export type KeyKind = 'session' | 'bearer' | 'ip';

function isDisabled(): boolean {
  return process.env.AUTH_RATE_LIMIT_METRICS_DISABLED === 'true';
}

const emitter = createBufferedMetricEmitter({
  namespace: NAMESPACE,
  isDisabled,
});

/**
 * Classifies which identity signal a rejected request carried, by reading
 * the `<kind>:<hash>` prefix `sessionRateLimitKeyFromRequest` already
 * computes — not re-derived, so this can't drift out of sync with that
 * function's bearer-beats-cookie-beats-ip precedence.
 *
 * Applies to BOTH limiters' rejections, including the IP-keyed abuse
 * ceiling. A caller minting a fresh bearer token on every request is
 * exactly the case the ceiling exists to catch (see the BS#2169 plan's "Why
 * the second limiter is not optional") — a `KeyKind: 'bearer'` datum on an
 * `ip`-limiter rejection is a meaningful signal, not a mislabel.
 */
function classifyKeyKind(req: Pick<Request, 'headers' | 'socket'>): KeyKind {
  const key = sessionRateLimitKeyFromRequest(req);
  const prefix = key.slice(0, key.indexOf(':'));
  return prefix === 'bearer' || prefix === 'session' ? prefix : 'ip';
}

function recordRateLimited(limiter: LimiterName, keyKind: KeyKind): void {
  emitter.record({
    metricName: METRIC_NAME,
    dimensions: [
      { name: 'Limiter', value: limiter },
      { name: 'KeyKind', value: keyKind },
      { name: 'Route', value: ROUTE },
    ],
    emitDimensionlessCompanion: false,
  });
}

/**
 * express-rate-limit `handler` factory for the two GET /auth/get-session
 * limiters. Supplying a custom `handler` replaces express-rate-limit's
 * default entirely — it only sends `options.message` from its own default
 * path — so this must send the response body itself to preserve the "one
 * 429 shape across every auth route" contract the other two auth limiters
 * rely on implicitly via their default handler (apps/auth/app.ts).
 */
export function makeHandler(limiter: LimiterName): RateLimitExceededEventHandler {
  return (req: Request, res: Response, _next: NextFunction, optionsUsed: Options): void => {
    const keyKind = classifyKeyKind(req);
    recordRateLimited(limiter, keyKind);

    // Breadcrumb, not captureMessage/captureException — a per-request Sentry
    // event on a rate-limit path is exactly the flood PR #691 and the org's
    // Sentry-quota history argue against.
    Sentry.addBreadcrumb({
      category: 'auth.ratelimit',
      level: 'warning',
      message: `GET ${ROUTE} rate limited (${limiter})`,
      data: { limiter, keyKind, route: ROUTE },
    });

    res.status(optionsUsed.statusCode).json(optionsUsed.message);
  };
}

/**
 * Test hook: clears buffered state and the singleton CloudWatch client. Not
 * exported from a barrel, only consumed by
 * tests/unit/auth/auth-rate-limit-metrics.test.ts.
 */
export function __resetForTests(): void {
  emitter.reset();
}

/**
 * Test hook: forces an immediate flush of any buffered metrics. Returns the
 * promise so tests can await the CloudWatch interaction deterministically.
 */
export function __flushForTests(): Promise<void> {
  return emitter.flush();
}
