import express from 'express';
import request from 'supertest';
import {
  CompositeReporter,
  createExpressErrorMiddleware,
  requestScopeMiddleware,
  setErrorReporter,
  setExpressErrorReporter,
} from '@wxyc/observability';
import type { ErrorReporter } from '@wxyc/observability';
import { PostHogReporter } from '@wxyc/observability/posthog';
import { LmlClientError } from '@wxyc/lml-client';
import { useSpyReporter } from '../../utils/observability';
import { requestIdMiddleware } from '../../../apps/backend/middleware/requestId';
import { shouldCaptureExpressError } from '../../../apps/backend/middleware/sentryErrorFilter';
import { shouldCaptureAuthExpressError } from '../../../apps/auth/sentry-error-filter';
import WxycError from '../../../apps/backend/utils/error';

const mockClient = { captureException: jest.fn(), capture: jest.fn(), flush: jest.fn() };
jest.mock('posthog-node', () => ({ PostHog: jest.fn(() => mockClient) }));

const EXPECTED_EVENT_KEYS = [
  '$process_person_profile',
  'environment',
  'method',
  'request_id',
  'route',
  'service',
  'status',
];

const sentProperties = (): Array<Record<string, unknown>> => [
  ...mockClient.captureException.mock.calls.map((call) => call[2] as Record<string, unknown>),
  ...mockClient.capture.mock.calls.map((call) => call[0].properties as Record<string, unknown>),
];

describe('Express request scope and PostHog error middleware', () => {
  const originalKey = process.env.POSTHOG_ERRORS_API_KEY;
  const processReporter = useSpyReporter();
  let postHog: PostHogReporter;
  let log: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.POSTHOG_ERRORS_API_KEY = 'phc_test';
    log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    postHog = new PostHogReporter({ service: 'backend', budget: { kind: 'daily', ceiling: 300 } });
    setExpressErrorReporter(postHog);
  });

  afterEach(() => {
    log.mockRestore();
    if (originalKey === undefined) {
      delete process.env.POSTHOG_ERRORS_API_KEY;
    } else {
      process.env.POSTHOG_ERRORS_API_KEY = originalKey;
    }
  });

  describe('requestScopeMiddleware', () => {
    it('gives two concurrent requests their own request_id and breadcrumbs', async () => {
      const composite: ErrorReporter = new CompositeReporter([processReporter, postHog]);
      setErrorReporter(composite);
      let release!: () => void;
      const bothArrived = new Promise<void>((resolve) => (release = resolve));
      let arrived = 0;
      const app = express();
      app.use(requestScopeMiddleware);
      app.use(requestIdMiddleware);
      app.get('/:who', async (req, res) => {
        composite.addBreadcrumb({ message: `crumb ${req.params.who}` });
        if (++arrived === 2) {
          release();
        }
        await bothArrived;
        composite.captureMessage(`seen by ${req.params.who}`);
        res.sendStatus(204);
      });

      await Promise.all([
        request(app).get('/alice').set('X-Request-Id', 'req-alice'),
        request(app).get('/bob').set('X-Request-Id', 'req-bob'),
      ]);

      const events = sentProperties();
      expect(events).toHaveLength(2);
      for (const who of ['alice', 'bob']) {
        const event = events.find((e) => JSON.stringify(e).includes(`seen by ${who}`));
        expect(event).toMatchObject({ request_id: `req-${who}` });
        expect(event?.breadcrumbs).toEqual([expect.objectContaining({ message: `crumb ${who}` })]);
      }
    });

    it('calls next directly when the registered reporter has no runInScope', () => {
      const next = jest.fn();
      requestScopeMiddleware({}, {}, next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('createExpressErrorMiddleware', () => {
    const buildApp = (shouldCapture: (e: Error) => boolean, boom: () => unknown) => {
      const app = express();
      app.use(requestScopeMiddleware);
      app.use(requestIdMiddleware);
      app.get('/things/:id', (_req, _res, next) => next(boom()));
      app.use(createExpressErrorMiddleware({ shouldCapture, statusOf: () => 500 }));
      app.use((_err: unknown, _req: unknown, res: express.Response, _next: unknown) => {
        res.status(500).json({ message: 'Internal server error' });
      });
      return app;
    };

    it('sends only request_id, route, method and status, never headers, cookies, query, body or IP', async () => {
      const app = buildApp(
        () => true,
        () => new Error('boom')
      );
      await request(app)
        .get('/things/7?token=secret')
        .set('X-Request-Id', 'req-1')
        .set('Cookie', 'session=secret')
        .set('Authorization', 'Bearer secret');

      const [event] = sentProperties();
      expect(event).toMatchObject({ request_id: 'req-1', route: '/things/:id', method: 'GET', status: 500 });
      const serialized = JSON.stringify(event);
      for (const leak of ['secret', 'session', 'Authorization', '7?token', '127.0.0.1', '::1']) {
        expect(serialized).not.toContain(leak);
      }
      // Exact set: anything beyond the reporter's own fields and the four tags fails (BS#3004).
      for (const forbidden of ['headers', 'cookies', 'query', 'body', 'ip']) {
        expect(event).not.toHaveProperty(forbidden);
      }
      expect(Object.keys(event).sort()).toEqual(EXPECTED_EVENT_KEYS);
    });

    it('reports to the express reporter only, never to the process-wide reporter Sentry also sits behind', async () => {
      await request(
        buildApp(
          () => true,
          () => new Error('boom')
        )
      ).get('/things/1');
      expect(mockClient.captureException).toHaveBeenCalledTimes(1);
      expect(processReporter.captureException).not.toHaveBeenCalled();
    });

    it('still answers the request when the reporter throws', async () => {
      const throwing = {
        ...processReporter,
        captureException: () => {
          throw new Error('reporter down');
        },
      };
      const app = express();
      setExpressErrorReporter(throwing);
      app.get('/', (_req, _res, next) => next(new Error('boom')));
      app.use(createExpressErrorMiddleware({ shouldCapture: () => true, statusOf: () => 500 }));
      app.use((_err: unknown, _req: unknown, res: express.Response, _next: unknown) => res.sendStatus(500));
      await request(app).get('/').expect(500);
    });

    // BS#1694 (backend) and BS#1387 (auth): the PostHog path reuses the same predicates Sentry's expressIntegration is given.
    it.each([
      ['backend: LmlClientError', shouldCaptureExpressError, () => new LmlClientError('timeout', 504), false],
      ['backend: WxycError 404', shouldCaptureExpressError, () => new WxycError('missing', 404), false],
      ['backend: WxycError 500', shouldCaptureExpressError, () => new WxycError('broken', 500), true],
      [
        'backend: trusted foreign 4xx',
        shouldCaptureExpressError,
        () => Object.assign(new Error('bad'), { status: 400, expose: true }),
        false,
      ],
      ['backend: foreign Error without a status', shouldCaptureExpressError, () => new Error('boom'), true],
      [
        'auth: status 400',
        shouldCaptureAuthExpressError,
        () => Object.assign(new Error('bad'), { status: 400 }),
        false,
      ],
      [
        'auth: status 503',
        shouldCaptureAuthExpressError,
        () => Object.assign(new Error('down'), { statusCode: 503 }),
        true,
      ],
      ['auth: no status', shouldCaptureAuthExpressError, () => new Error('boom'), true],
      [
        'auth: NaN status',
        shouldCaptureAuthExpressError,
        () => Object.assign(new Error('odd'), { status: 'abc' }),
        true,
      ],
    ])('%s -> captured: %s', async (_name, predicate, boom, captured) => {
      await request(buildApp(predicate, boom)).get('/things/1');
      expect(mockClient.captureException).toHaveBeenCalledTimes(captured ? 1 : 0);
    });

    it('passes the raw pipeline value to the predicate and reports a thrown non-Error as an Error', async () => {
      const predicate = jest.fn(() => true);
      await request(buildApp(predicate, () => 'plain string')).get('/things/1');
      expect(predicate).toHaveBeenCalledWith('plain string');
      expect(mockClient.captureException.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    it('reports the status the app renders, from statusOf', async () => {
      const app = express();
      app.get('/', (_req, _res, next) => next(new WxycError('upstream', 503)));
      app.use(
        createExpressErrorMiddleware({
          shouldCapture: () => true,
          statusOf: (e) => (e instanceof WxycError ? e.statusCode : 500),
        })
      );
      app.use((_err: unknown, _req: unknown, res: express.Response, _next: unknown) => res.sendStatus(503));
      await request(app).get('/');
      expect(sentProperties()[0]).toMatchObject({ status: 503, route: '/' });
    });
    it('tags errors from a router-mounted route with the full template, mount prefix included', async () => {
      const router = express.Router();
      router.get('/:id', (_req, _res, next) => next(new Error('boom')));
      router.get('/', (_req, _res, next) => next(new Error('boom on the index')));
      const app = express();
      app.use(requestScopeMiddleware);
      app.use('/flowsheet', router);
      app.use(createExpressErrorMiddleware({ shouldCapture: () => true, statusOf: () => 500 }));
      app.use((_err: unknown, _req: unknown, res: express.Response, _next: unknown) => res.sendStatus(500));
      await request(app).get('/flowsheet/7');
      await request(app).get('/flowsheet?x=1');
      expect(sentProperties().map((e) => e.route)).toEqual(['/flowsheet/:id', '/flowsheet']);
    });

    it('names the route "unmatched" when the error came from outside any route', async () => {
      const app = express();
      app.use((_req, _res, next) => next(new Error('boom')));
      app.use(createExpressErrorMiddleware({ shouldCapture: () => true, statusOf: () => 500 }));
      app.use((_err: unknown, _req: unknown, res: express.Response, _next: unknown) => res.sendStatus(500));
      await request(app).get('/anything?q=1');
      expect(sentProperties()[0]).toMatchObject({ route: 'unmatched' });
    });
  });
});
