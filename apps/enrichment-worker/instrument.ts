// Sentry preload (node --import). Mirrors apps/backend/instrument.ts so the
// worker's outbound LML fetch spans nest under a CDC handler transaction.
// Sentry stays inactive when SENTRY_DSN is unset (the SDK silently no-ops).

import { config } from 'dotenv';
import * as Sentry from '@sentry/node';

config();

// Default 0.1 — the worker is many-instance and high-throughput; full sample
// of every CDC handler transaction would dominate the BS Sentry budget. The
// runtime backend defaults to 1.0 because per-request HTTP transactions are
// already bounded by user traffic. Operators can override with
// SENTRY_TRACES_SAMPLE_RATE per-deploy without a code change.
const resolveTracesSampleRate = (raw: string | undefined = process.env.SENTRY_TRACES_SAMPLE_RATE): number => {
  if (raw === undefined) return 0.1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 0.1;
  return parsed;
};

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  release: process.env.SENTRY_RELEASE,
  environment: process.env.NODE_ENV || 'production',
  tracesSampleRate: resolveTracesSampleRate(),
});
