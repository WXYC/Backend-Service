/**
 * Pins the per-run PostHog error budget the two frequent crons pass to `createJobLogger` (BS#3409).
 * Both run at least hourly, so each takes 2 events a run rather than the default 10. The test imports
 * the real job modules and reads the options they hand to the factory, so a changed or dropped
 * `errorBudget` fails here.
 */
import { describe, it, expect, jest } from '@jest/globals';

const captured: Array<{ jobName: string; errorBudget?: number }> = [];

jest.mock('@wxyc/observability/job-logger', () => {
  const noop = () => undefined;
  return {
    ...jest.requireActual<Record<string, unknown>>('@wxyc/observability/job-logger'),
    createJobLogger: (options: { jobName: string; errorBudget?: number }) => {
      captured.push(options);
      return {
        initLogger: noop,
        log: noop,
        captureError: noop,
        captureWarning: noop,
        errorMessage: noop,
        closeLogger: noop,
        withHeartbeat: noop,
      };
    },
  };
});

import '../../../jobs/legacy-linkage-resolve/job';
import '../../../jobs/flowsheet-metadata-backfill/logger';

describe('job PostHog error budget (BS#3409)', () => {
  it.each([['legacy-linkage-resolve'], ['flowsheet-metadata-backfill']])('%s passes errorBudget: 2', (jobName) => {
    const options = captured.find((o) => o.jobName === jobName);

    expect(options).toBeDefined();
    expect(options?.errorBudget).toBe(2);
  });
});
