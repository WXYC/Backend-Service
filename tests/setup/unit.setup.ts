import { jest } from '@jest/globals';
import { setErrorReporter } from '@wxyc/observability';
import type { ErrorReporter } from '@wxyc/observability';

// Jest defaults NODE_ENV to 'test' but some shells unset it; pin explicitly
// so the dev/test guards in route modules (e.g. the rate-limiter passthrough
// in apps/backend/routes/internal-bans.route.ts) consistently fire.
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

// SES has a 200-message/month quota; keep real sends off by default in the
// unit suite so a test that forgets to mock @aws-sdk/client-ses can't burn
// it. See shared/authentication/src/email.ts `isEmailSendingEnabled`.
process.env.EMAIL_ENABLED = process.env.EMAIL_ENABLED ?? 'false';

// withHeartbeat (createJobLogger) publishes to CloudWatch via the EC2 instance role; keep the unit
// suite off the network (real IMDS calls). The heartbeat's own test clears this per test.
process.env.CRON_HEARTBEAT_METRICS_DISABLED = process.env.CRON_HEARTBEAT_METRICS_DISABLED ?? 'true';

jest.setTimeout(10000);

// apps/backend registers its SentryReporter in instrument.ts, which no unit test loads. Register one
// here so a test's `jest.mock('@sentry/node')` assertions on captures still see them (BS#3395). The
// SentryReporter is required per call, not at setup time: setup runs before the test file's
// jest.mock, and an eager import would cache the real SDK in the module registry.
const sentryReporter = (): ErrorReporter => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SentryReporter } = require('@wxyc/observability/sentry') as typeof import('@wxyc/observability/sentry');
  return new SentryReporter();
};
setErrorReporter({
  captureException: (err, context) => sentryReporter().captureException(err, context),
  captureMessage: (message, context) => sentryReporter().captureMessage(message, context),
  addBreadcrumb: (crumb) => sentryReporter().addBreadcrumb(crumb),
  setRequestTag: (key, value) => sentryReporter().setRequestTag(key, value),
  flush: (timeoutMs) => sentryReporter().flush(timeoutMs),
});

beforeEach(() => {
  jest.clearAllMocks();
});
