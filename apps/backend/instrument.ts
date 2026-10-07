// First import: ESM evaluates every import before this module's body, so a
// `config()` call down there would run after the imports below had already
// read the environment (@wxyc/lml-client fixes its limits at module load).
// In production, Docker --env-file sets vars before Node starts, so this is a no-op.
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import { filterSentryTransactionEvent, warnIfReservedAwsCredentialsPresent } from '@wxyc/observability';
import { resolveTracesSampleRate } from './sentry-config.js';
import { shouldCaptureExpressError } from './middleware/sentryErrorFilter.js';

// Immediately after .env loads, because .env is one of the ways a reserved AWS
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
  integrations: [Sentry.expressIntegration({ shouldHandleError: shouldCaptureExpressError })],
});
