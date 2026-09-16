import { config } from 'dotenv';
import * as Sentry from '@sentry/node';
import { filterSentryTransactionEvent, warnIfReservedAwsCredentialsPresent } from '@wxyc/observability';
import { resolveTracesSampleRate } from './sentry-config.js';

// Load .env before Sentry.init() so SENTRY_DSN is available.
// In production, Docker --env-file sets vars before Node starts, so this is a no-op.
config();

// Immediately after config(), because .env is one of the ways a reserved AWS
// credential name reaches this process. This container holds two of the repo's
// three CloudWatchClient constructions and sends no email, so it is exactly the
// process the old per-SES-sender placement could not warn (BS#2532/BS#2518).
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
