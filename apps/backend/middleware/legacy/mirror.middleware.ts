import { NextFunction, Request, Response } from 'express';
import { MirrorCommandQueue } from './commandqueue.mirror';
import { getPostHogClient } from '../../utils/posthog.js';
import { addMirrorBreadcrumb, captureMirrorException, hashSha256Hex, type MirrorLogContext } from './mirror.logging';

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
  <T>(operation: string, createCommand: (req: Request, data: T) => Promise<string[]>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    tapJsonResponse(res);

    // After the response is sent, decide whether to enqueue work
    res.once('finish', () => {
      void (async () => {
        try {
          const ok = res.statusCode >= 200 && res.statusCode < 305;
          const data = (res.locals as any).mirrorData as T | undefined;

          const requestId = (res.getHeader('X-Request-Id') ?? req.get('X-Request-Id'))?.toString();
          const ctx = buildMirrorContext({ operation, req, res, data, requestId });

          if (!ok) {
            addMirrorBreadcrumb('Mirror skipped: non-success http status', { http_status: res.statusCode }, ctx, 'debug');
            return;
          }

          if (data == null) {
            addMirrorBreadcrumb('Mirror skipped: missing mirrorData', { http_status: res.statusCode }, ctx, 'debug');
            return;
          }

          const mirrorOn = await isMirrorEnabled(req);
          ctx.mirrorFeatureEnabled = mirrorOn;
          const distinctId = (req as any).user?.id ?? req.ip ?? 'anonymous';
          const distinctIdHash = distinctId ? hashSha256Hex(String(distinctId)) : undefined;

          if (!mirrorOn) {
            addMirrorBreadcrumb(
              'Mirror skipped: backend-mirror flag disabled',
              { mirror_feature_enabled: mirrorOn, posthog_distinct_id_hash: distinctIdHash },
              ctx,
              'info'
            );
            return;
          }

          addMirrorBreadcrumb('Mirror enqueue: generating SQL', { http_status: res.statusCode }, ctx, 'info');
          const queue = MirrorCommandQueue.instance();
          const sqls = await createCommand(req, data);
          const cmd = queue.enqueue(sqls, ctx);
          if (cmd) {
            ctx.mirrorCmdId = cmd.id;
            addMirrorBreadcrumb(
              'Mirror enqueue: queued command',
              { mirror_cmd_id: cmd.id, statementsCount: cmd.statementsCount },
              cmd.context ?? ctx,
              'info'
            );
          } else {
            addMirrorBreadcrumb('Mirror enqueue: queue is dead; command not enqueued', { mirror_cmd_id: 'unknown' }, ctx, 'warning');
          }
        } catch (e) {
          captureMirrorException(e, {
            operation,
            requestId: (res.getHeader('X-Request-Id') ?? req.get('X-Request-Id'))?.toString(),
            httpStatus: res.statusCode,
          });
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
  <T>(operation: string, execute: (req: Request, data: T) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    tapJsonResponse(res);

    res.once('finish', () => {
      void (async () => {
        try {
          const ok = res.statusCode >= 200 && res.statusCode < 305;
          const data = (res.locals as any).mirrorData as T | undefined;

          const requestId = (res.getHeader('X-Request-Id') ?? req.get('X-Request-Id'))?.toString();
          const ctx = buildMirrorContext({ operation, req, res, data, requestId });

          if (!ok) {
            addMirrorBreadcrumb('HTTP mirror skipped: non-success http status', { http_status: res.statusCode }, ctx, 'debug');
            return;
          }

          if (data == null) {
            addMirrorBreadcrumb('HTTP mirror skipped: missing mirrorData', { http_status: res.statusCode }, ctx, 'debug');
            return;
          }

          const mirrorOn = await isMirrorEnabled(req);
          ctx.mirrorFeatureEnabled = mirrorOn;

          if (!mirrorOn) {
            addMirrorBreadcrumb('HTTP mirror skipped: backend-mirror flag disabled', { mirror_feature_enabled: mirrorOn }, ctx, 'info');
            return;
          }

          addMirrorBreadcrumb('HTTP mirror: executing callback', {}, ctx, 'info');
          await execute(req, data);
        } catch (e) {
          captureMirrorException(e, {
            operation,
            requestId: (res.getHeader('X-Request-Id') ?? req.get('X-Request-Id'))?.toString(),
            httpStatus: res.statusCode,
          });
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

function buildMirrorContext<T>(params: {
  operation: string;
  req: Request;
  res: Response;
  data: T | undefined;
  requestId?: string;
}): MirrorLogContext {
  const { operation, req, res, data, requestId } = params;

  const route = (req.route?.path ?? req.path ?? req.originalUrl)?.toString();
  const method = req.method;

  let showId: string | number | undefined;
  let djId: string | undefined;

  if (data && typeof data === 'object') {
    const anyData = data as any;

    // Show-like objects
    if (anyData?.primary_dj_id && anyData?.id !== undefined) {
      showId = anyData.id;
      djId = String(anyData.primary_dj_id);
    }

    // FSEntry-like objects
    if (anyData?.show_id != null) showId = anyData.show_id;
    if (anyData?.dj_id) djId = String(anyData.dj_id);
  }

  return {
    operation,
    requestId,
    showId,
    djId,
    route,
    method,
    httpStatus: res.statusCode,
  };
}
