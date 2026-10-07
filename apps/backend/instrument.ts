// First import: ESM evaluates every import before this module's body, so a
// `config()` call down there would run after the imports below had already
// read the environment (@wxyc/lml-client fixes its limits at module load).
// In production, Docker --env-file sets vars before Node starts, so this is a no-op.
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import {
  SENTRY_DATA_COLLECTION,
  filterSentryTransactionEvent,
  warnIfReservedAwsCredentialsPresent,
} from '@wxyc/observability';
import { resolveTracesSampleRate } from './sentry-config.js';
import { shouldCaptureExpressError } from './middleware/sentryErrorFilter.js';

// Immediately after .env loads, because .env is one of the ways a reserved AWS
// credential name reaches this process. This container holds two of the repo's
// three CloudWatchClient constructions and sent no email when BS#2532 moved the
// check here, so it is exactly the process the old per-SES-sender placement
// could not warn (BS#2532/BS#2518). It now sends the music-director review
// notices (BS#2806), but only lazily and not at all under EMAIL_ENABLED=false,
// so the check still belongs at boot.
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
  // Sentry 11 defaults to span streaming, which never builds a transaction
  // event, so `beforeSendTransaction` above would never run (BS#2948). Pin the
  // transaction lifecycle Sentry 10 used until the filter moves to streaming
  // (BS#2959).
  traceLifecycle: 'static',
  // v11's expressIntegration captures Express errors itself, and its
  // `shouldHandleError` outranks the deprecated `setupExpressErrorHandler`'s
  // options, so the filter has to be passed here (BS#2949). This is a default
  // integration; passing it overrides the default instance with ours.
  integrations: [Sentry.expressIntegration({ shouldHandleError: shouldCaptureExpressError })],
  // Sentry 10's data-collection posture: no end-user IPs, IP-bearing headers
  // or request bodies (BS#3004).
  dataCollection: SENTRY_DATA_COLLECTION,
});
