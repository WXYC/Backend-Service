import { config } from 'dotenv';
import * as Sentry from '@sentry/node';

// Load .env before Sentry.init() so SENTRY_DSN is available.
// In production, Docker --env-file sets vars before Node starts, so this is a no-op.
config();

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  release: process.env.SENTRY_RELEASE,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 1.0,
});
