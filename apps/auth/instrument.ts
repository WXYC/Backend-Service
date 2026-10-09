// First import: ESM evaluates every import before this module's body, so a
// `config()` call down there would run after the imports below had already
// read the environment.
// In production, Docker --env-file sets vars before Node starts, so this is a no-op.
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import {
  SENTRY_DATA_COLLECTION,
  filterSentryTransactionEvent,
  redactSentryEventQueryParams,
  warnIfReservedAwsCredentialsPresent,
} from '@wxyc/observability';
import { resolveTracesSampleRate } from './sentry-config.js';
import { shouldCaptureAuthExpressError } from './sentry-error-filter.js';

// At boot, not on the first password-reset/OTP send: this container publishes
// the get-session rate-limit metric from the moment it starts, and the old
// per-sender placement also went silent entirely under EMAIL_ENABLED=false
// (BS#2532/BS#2518).
warnIfReservedAwsCredentialsPresent();

Sentry.init({
  // Sentry 11 turned this on by default, which titles captureMessage events
  // with a minified function name (BS#3002).
  attachStacktrace: false,
  dsn: process.env.SENTRY_DSN,
  release: process.env.SENTRY_RELEASE,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: resolveTracesSampleRate(),
  // Drops the /auth/ok and /healthcheck liveness probes — matched on request
  // path, since better-auth's mount makes /auth/ok's transaction "GET /auth" —
  // and strips Express middleware bookkeeping spans from every surviving
  // transaction (BS#2089).
  // Error reporting (the Express error filter) is untouched —
  // wxyc-canary depends on /healthcheck errors surfacing there.
  beforeSendTransaction: filterSentryTransactionEvent,
  // A failed Drizzle query's message quotes every bound value, which since
  // BS#3051 can be a staff member's legal name; the SQL stays, the values go
  // (BS#3054). Error capture itself is unchanged.
  beforeSend: redactSentryEventQueryParams,
  // Sentry 11 defaults to span streaming, which never builds a transaction
  // event, so `beforeSendTransaction` above would never run (BS#2948). Pin the
  // transaction lifecycle Sentry 10 used until the filter moves to streaming
  // (BS#2959).
  traceLifecycle: 'static',
  // v11's expressIntegration captures Express errors itself, and its
  // `shouldHandleError` outranks the deprecated `setupExpressErrorHandler`'s
  // options, so the filter has to be passed here (BS#2949). This is a default
  // integration; passing it overrides the default instance with ours.
  integrations: [Sentry.expressIntegration({ shouldHandleError: shouldCaptureAuthExpressError })],
  // Sentry 10's data-collection posture: no end-user IPs, IP-bearing headers
  // or request bodies (BS#3004).
  dataCollection: SENTRY_DATA_COLLECTION,
});
