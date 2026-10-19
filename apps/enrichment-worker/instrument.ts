// Sentry preload (node --import). Mirrors apps/backend/instrument.ts.
// Sentry stays inactive when SENTRY_DSN is unset (the SDK silently no-ops).

import { config } from 'dotenv';
import * as Sentry from '@sentry/node';
import { SENTRY_DATA_COLLECTION, warnIfReservedAwsCredentialsPresent } from '@wxyc/observability';

config();

// The worker publishes no CloudWatch metrics today, but it shares the EC2
// host's `~/.env` with backend and auth — so a reserved AWS credential name
// re-armed there is a fleet-wide fact, and any container that boots is a
// chance to say so. Covering every preload, rather than only the processes
// that happen to call CloudWatch today, is the point of BS#2532.
warnIfReservedAwsCredentialsPresent();

Sentry.init({
  // Sentry 11 turned this on by default, which titles captureMessage events
  // with a minified function name (BS#3002).
  attachStacktrace: false,
  // Sentry 11 installs Dedupe by default, which drops repeated identical events (BS#3005).
  integrations: (defaults) => defaults.filter((i) => i.name !== 'Dedupe'),
  dsn: process.env.SENTRY_DSN,
  release: process.env.SENTRY_RELEASE,
  environment: process.env.NODE_ENV || 'production',
  // Sentry 10's data-collection posture: no end-user IPs, IP-bearing headers
  // or request bodies (BS#3004).
  dataCollection: SENTRY_DATA_COLLECTION,
});
