/**
 * BS#3398: `album-reviews-etl` and `album-critic-reviews-etl` have always sent `captureWarning` to Sentry with no
 * fingerprint, so each distinct message (e.g. one per `normalization_anomaly` kind) opens its own issue. The shared
 * logger's `captureWarning` fingerprints by `[jobName, step]`, which would merge them; these jobs export the shared
 * `captureMessage` under the old name to keep the grouping.
 */

import { jest } from '@jest/globals';

jest.mock('@sentry/node', () => ({
  __esModule: true,
  init: jest.fn(),
  setTag: jest.fn(),
  captureMessage: jest.fn(),
  flush: jest.fn(() => Promise.resolve(true)),
  close: jest.fn(() => Promise.resolve(true)),
}));

import * as Sentry from '@sentry/node';

describe.each(['album-reviews-etl', 'album-critic-reviews-etl'])('%s captureWarning', (job) => {
  it('sends a warning-level message with the step tag and no fingerprint', async () => {
    const { initLogger, captureWarning, closeLogger } = await import(`../../../../jobs/${job}/logger`);
    initLogger({ repo: 'Backend-Service', tool: job });
    captureWarning('something drifted', 'normalization_anomaly', { kind: 'x' });
    await closeLogger();

    expect(Sentry.captureMessage).toHaveBeenCalledWith('something drifted', {
      level: 'warning',
      tags: { step: 'normalization_anomaly' },
      extra: { kind: 'x' },
    });
  });
});
