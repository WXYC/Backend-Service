// First import: ESM evaluates every import before this module's body, so a
// `config()` call down there would run after the imports below had already
// read the environment (@wxyc/lml-client fixes its limits at module load).
// In production, Docker --env-file sets vars before Node starts, so this is a no-op.
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import {
  SENTRY_DATA_COLLECTION,
  redactSentryBreadcrumb,
  redactSentryEventQueryParams,
  CompositeReporter,
  logCounter,
  setErrorReporter,
  setExpressErrorReporter,
  warnIfReservedAwsCredentialsPresent,
} from '@wxyc/observability';
import { PostHogReporter, installCrashHandlers } from '@wxyc/observability/posthog';
import { SentryReporter } from '@wxyc/observability/sentry';
import { setLmlCounterSink } from '@wxyc/lml-client';
import { shouldCaptureExpressError } from './middleware/sentryErrorFilter.js';

// Immediately after .env loads, because .env is one of the ways a reserved AWS
// credential name reaches this process. This container holds two of the repo's
// three CloudWatchClient constructions and sent no email when BS#2532 moved the
// check here, so it is exactly the process the old per-SES-sender placement
// could not warn (BS#2532/BS#2518). It now sends the music-director review
// notices (BS#2806), but only lazily and not at all under EMAIL_ENABLED=false,
// so the check still belongs at boot.
warnIfReservedAwsCredentialsPresent();

// @sentry/node falls back to SENTRY_TRACES_SAMPLE_RATE when no option is given, and a stale `.env` may still set it; tracing stays off (BS#3403).
delete process.env.SENTRY_TRACES_SAMPLE_RATE;

Sentry.init({
  // Sentry 11 turned this on by default, which titles captureMessage events
  // with a minified function name (BS#3002).
  attachStacktrace: false,
  dsn: process.env.SENTRY_DSN,
  release: process.env.SENTRY_RELEASE,
  environment: process.env.NODE_ENV || 'development',
  // A failed Drizzle query's message quotes every bound value, which since
  // BS#3051 can be a staff member's legal name; the SQL stays, the values go
  // (BS#3054). Error capture itself is unchanged.
  beforeSend: redactSentryEventQueryParams,
  // The console integration also keeps the raw console arguments in `data.arguments`; scrub them as the breadcrumb
  // is recorded, while they are still Error objects, so transaction events are covered too (BS#3054).
  beforeBreadcrumb: redactSentryBreadcrumb,
  // v11's expressIntegration captures Express errors itself, and its
  // `shouldHandleError` outranks the deprecated `setupExpressErrorHandler`'s
  // options, so the filter has to be passed here (BS#2949). This is a default
  // integration; passing it overrides the default instance with ours.
  // Sentry 11 also installs Dedupe by default, which drops repeated identical events (BS#3005).
  // An integrations array can only add to or replace defaults by name, never remove one, so the
  // function form is used: it receives the defaults, drops Dedupe, and appends our Express integration.
  integrations: (defaults) => [
    ...defaults.filter((i) => i.name !== 'Dedupe'),
    Sentry.expressIntegration({ shouldHandleError: shouldCaptureExpressError }),
  ],
  // Sentry 10's data-collection posture: no end-user IPs, IP-bearing headers
  // or request bodies (BS#3004).
  dataCollection: SENTRY_DATA_COLLECTION,
});

// Every capture, breadcrumb and request tag in apps/backend goes through the
// ErrorReporter seam (BS#3395), to Sentry and PostHog for the parity window (BS#3409).
// PostHog is a no-op without POSTHOG_ERRORS_API_KEY. Budget: 300 a day (error-tracking contract).
const postHog = new PostHogReporter({
  service: 'backend',
  environment: process.env.NODE_ENV,
  release: process.env.SENTRY_RELEASE,
  budget: { kind: 'daily', ceiling: 300 },
});
setErrorReporter(new CompositeReporter([new SentryReporter(), postHog]));
// Sentry's expressIntegration captures Express errors itself; PostHog has no such integration, so the
// Express error middleware in app.ts reports to PostHog alone.
setExpressErrorReporter(postHog);
// Crashes go to PostHog alone (Sentry's integration reports its own); the handler owns the exit and closes Sentry first (BS#3517).
installCrashHandlers(postHog, () => Sentry.close(2000));

// LML cache_stats counter lines (BS#3508); lml-client takes the sink by injection so it needs no @wxyc/observability.
setLmlCounterSink(logCounter);
