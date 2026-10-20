/**
 * An auth route that throws a non-Error reaches both PostHog paths: the Express error middleware and
 * `fallbackErrorHandler` through the process-wide composite. The reporter's 60 s dedupe collapses the pair
 * only when both paths hand it the same value, so a non-Error must be normalised the same way in each (BS#3409).
 */
import express from 'express';
import request from 'supertest';
import {
  CompositeReporter,
  createExpressErrorMiddleware,
  getErrorReporter,
  setErrorReporter,
  setExpressErrorReporter,
} from '@wxyc/observability';
import { PostHogReporter } from '@wxyc/observability/posthog';
import { shouldCaptureAuthExpressError } from '../../../apps/auth/sentry-error-filter';
import { fallbackErrorHandler } from '../../../apps/auth/fallback-error-handler';

const mockClient = { captureException: jest.fn(), capture: jest.fn(), flush: jest.fn() };
jest.mock('posthog-node', () => ({ PostHog: jest.fn(() => mockClient) }));

describe('auth non-Error throw reaches PostHog once (BS#3409)', () => {
  const originalKey = process.env.POSTHOG_ERRORS_API_KEY;
  const previous = getErrorReporter();

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.POSTHOG_ERRORS_API_KEY = 'phc_test';
    const postHog = new PostHogReporter({ service: 'auth', budget: { kind: 'daily', ceiling: 100 } });
    setErrorReporter(new CompositeReporter([postHog]));
    setExpressErrorReporter(postHog);
  });

  afterEach(() => {
    setErrorReporter(previous);
    if (originalKey === undefined) {
      delete process.env.POSTHOG_ERRORS_API_KEY;
    } else {
      process.env.POSTHOG_ERRORS_API_KEY = originalKey;
    }
  });

  it.each([
    ['a string', 'something broke'],
    ['an Error', new Error('something broke')],
  ])('sends one PostHog event when a route throws %s', async (_label, thrown) => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = express();
    app.get('/boom', () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error throw is the case under test
      throw thrown;
    });
    app.use(createExpressErrorMiddleware({ shouldCapture: shouldCaptureAuthExpressError, statusOf: () => 500 }));
    app.use(fallbackErrorHandler);

    await request(app).get('/boom').expect(500);

    expect(mockClient.captureException.mock.calls.length + mockClient.capture.mock.calls.length).toBe(1);
  });
});
