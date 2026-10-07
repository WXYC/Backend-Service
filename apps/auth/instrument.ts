// First import: ESM evaluates every import before this module's body, so a
// `config()` call down there would run after the imports below had already
// read the environment.
// In production, Docker --env-file sets vars before Node starts, so this is a no-op.
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import { filterSentryTransactionEvent, warnIfReservedAwsCredentialsPresent } from '@wxyc/observability';
import { resolveTracesSampleRate } from './sentry-config.js';
import { shouldCaptureAuthExpressError } from './sentry-error-filter.js';

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
  // Error reporting (beforeSend / the Express error filter) is untouched —
  // wxyc-canary depends on /healthcheck errors surfacing there.
  beforeSendTransaction: filterSentryTransactionEvent,
  // v11 defaults to `traceLifecycle: 'stream'`, which ignores
  // `beforeSendTransaction` (it logs a warning at boot and sends every
  // transaction unfiltered). 'static' keeps the filter above in effect until it
  // is ported to `ignoreSpans` / `beforeSendSpan` ahead of v12.
  traceLifecycle: 'static',
  // v11's expressIntegration captures Express errors itself, and its
  // `shouldHandleError` outranks the deprecated `setupExpressErrorHandler`'s
  // options, so the filter has to be passed here (BS#2949). This is a default
  // integration; passing it overrides the default instance with ours.
  integrations: [Sentry.expressIntegration({ shouldHandleError: shouldCaptureAuthExpressError })],
});
