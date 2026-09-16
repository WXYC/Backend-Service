import { config } from 'dotenv';
import * as Sentry from '@sentry/node';
import { filterSentryTransactionEvent, warnIfReservedAwsCredentialsPresent } from '@wxyc/observability';
import { resolveTracesSampleRate } from './sentry-config.js';

// Load .env before Sentry.init() so SENTRY_DSN is available.
// In production, Docker --env-file sets vars before Node starts, so this is a no-op.
config();

// At boot, not on the first password-reset/OTP send: this container publishes
// the get-session rate-limit metric from the moment it starts, and the old
// per-sender placement also went silent entirely under EMAIL_ENABLED=false
// (BS#2532/BS#2518).
warnIfReservedAwsCredentialsPresent();

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  release: process.env.SENTRY_RELEASE,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: resolveTracesSampleRate(),
  // Drops the /auth/ok and /healthcheck liveness probes — matched on request
  // path, since better-auth's mount makes /auth/ok's transaction "GET /auth" —
  // and strips Express middleware bookkeeping spans from every surviving
  // transaction (BS#2089).
  // Error reporting (beforeSend / setupExpressErrorHandler) is untouched —
  // wxyc-canary depends on /healthcheck errors surfacing there.
  beforeSendTransaction: filterSentryTransactionEvent,
});
