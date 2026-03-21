import { NextFunction, Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { MirrorCommandQueue } from './commandqueue.mirror';
import { getPostHogClient } from '../../utils/posthog.js';

/**
 * Check the PostHog `backend-mirror` feature flag. If PostHog is not
 * configured (no API key), the mirror is enabled by default so that
 * local development and E2E tests work without external dependencies.
 */
async function isMirrorEnabled(req: Request): Promise<boolean> {
  if (!process.env.POSTHOG_API_KEY) return true;

  const client = getPostHogClient();
  const distinctId = (req as any).user?.id ?? req.ip ?? 'anonymous';
  const enabled = await client.isFeatureEnabled('backend-mirror', distinctId);
  return enabled ?? false;
}

export const createBackendMirrorMiddleware =
  <T>(createCommand: (req: Request, data: T) => Promise<string[]>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    tapJsonResponse(res);

    // After the response is sent, decide whether to enqueue work
    res.once('finish', () => {
      void (async () => {
        try {
          console.log('Response finished, checking for mirror work...');
          const ok = res.statusCode >= 200 && res.statusCode < 305;
          const data = (res.locals as any).mirrorData as T | undefined;

          console.log('Response status:', res.statusCode, 'ok?', ok);

          if (!ok || data == null) return;

          const mirrorOn = await isMirrorEnabled(req);
          if (!mirrorOn) return;

          console.log('Enqueuing mirror work...');

          const queue = MirrorCommandQueue.instance();
          queue.enqueue(await createCommand(req, data));
        } catch (e) {
          console.error('Error in mirror middleware:', e);
          Sentry.captureException(e, { tags: { subsystem: 'legacy-mirror', variant: 'sql' } });
        }
      })();
    });

    next();
  };

/**
 * HTTP mirror middleware factory. Same response-tapping and PostHog feature flag
 * check as createBackendMirrorMiddleware, but calls an async callback that makes
 * HTTP calls instead of returning SQL strings for the command queue.
 */
export const createHttpMirrorMiddleware =
  <T>(execute: (req: Request, data: T) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    tapJsonResponse(res);

    res.once('finish', () => {
      void (async () => {
        try {
          const ok = res.statusCode >= 200 && res.statusCode < 305;
          const data = (res.locals as any).mirrorData as T | undefined;

          if (!ok || data == null) return;

          const mirrorOn = await isMirrorEnabled(req);
          if (!mirrorOn) return;

          await execute(req, data);
        } catch (e) {
          console.error('Error in HTTP mirror middleware:', e);
          Sentry.captureException(e, { tags: { subsystem: 'legacy-mirror', variant: 'http' } });
        }
      })();
    });

    next();
  };

function tapJsonResponse(res: Response) {
  const origSend = res.send.bind(res);

  res.send = ((body?: any) => {
    let captured: unknown = body;

    const ct = (res.getHeader('content-type') || '').toString().toLowerCase();
    if (typeof body === 'string' && ct.includes('application/json')) {
      try {
        captured = JSON.parse(body);
      } catch {
        // ignore parse errors; keep raw string
      }
    }

    if (Buffer.isBuffer(body) && ct.includes('application/json')) {
      try {
        captured = JSON.parse(body.toString('utf8'));
      } catch {
        /* ignore */
      }
    }
    (res.locals as any).mirrorData = captured;
    return origSend(body);
  }) as any;
}
