import { config } from 'dotenv';
import * as Sentry from '@sentry/node';
import { filterSentryTransactionEvent } from '@wxyc/observability';
import { resolveTracesSampleRate } from './sentry-config.js';

// Load .env before Sentry.init() so SENTRY_DSN is available.
// In production, Docker --env-file sets vars before Node starts, so this is a no-op.
config();

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  release: process.env.SENTRY_RELEASE,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: resolveTracesSampleRate(),
  // Drops /ok and /healthcheck liveness transactions and strips Express
  // middleware bookkeeping spans from every other transaction (BS#2089).
  // Error reporting (beforeSend / setupExpressErrorHandler) is untouched —
  // wxyc-canary depends on /healthcheck errors surfacing there.
  beforeSendTransaction: filterSentryTransactionEvent,
});
