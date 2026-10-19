// First import: ESM evaluates every import before this module's body, so a
// `config()` call down there would run after the imports below had already
// read the environment.
// In production, Docker --env-file sets vars before Node starts, so this is a no-op.
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import {
  SENTRY_DATA_COLLECTION,
  redactSentryBreadcrumb,
  redactSentryEventQueryParams,
  warnIfReservedAwsCredentialsPresent,
} from '@wxyc/observability';
import { shouldCaptureAuthExpressError } from './sentry-error-filter.js';

// At boot, not on the first password-reset/OTP send: this container publishes
// the get-session rate-limit metric from the moment it starts, and the old
// per-sender placement also went silent entirely under EMAIL_ENABLED=false
// (BS#2532/BS#2518).
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
    Sentry.expressIntegration({ shouldHandleError: shouldCaptureAuthExpressError }),
  ],
  // Sentry 10's data-collection posture: no end-user IPs, IP-bearing headers
  // or request bodies (BS#3004).
  dataCollection: SENTRY_DATA_COLLECTION,
});
