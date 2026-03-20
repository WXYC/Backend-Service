import * as Sentry from '@sentry/node';
import crypto from 'crypto';

export type MirrorLogContext = {
  requestId?: string;
  operation?: string;
  showId?: string | number;
  djId?: string;
  route?: string;
  method?: string;
  httpStatus?: number;
  mirrorCmdId?: string;
  attempt?: number;
  maxAttempts?: number;
  mirrorFeatureEnabled?: boolean;
};

export type MirrorCommandSummary = {
  id: string;
  enqueuedAt: number;
  attempts: number;
  status: MirrorCommandStatus;
  lastError?: string;
  sqlLength: number;
  sqlHash: string;
  statementsCount: number;
  // Not persisted to disk; safe for in-memory context only.
  context?: MirrorLogContext;
};

export type MirrorCommandStatus = 'pending' | 'in_progress' | 'in_progress_retrying' | 'completed' | 'failed';

const MAX_STRING_LEN_DEFAULT = 1024;
const MAX_SQL_PREVIEW_LEN = 256;
const MAX_TAG_VALUE_LEN = 64;

function truncateString(input: unknown, maxLen: number): string | undefined {
  if (input === undefined || input === null) return undefined;
  const s = typeof input === 'string' ? input : String(input);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

export function hashSha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function summarizeSql(sql: string) {
  return {
    sqlLength: sql.length,
    sqlHash: hashSha256Hex(sql),
    sqlPreview: truncateString(sql, MAX_SQL_PREVIEW_LEN),
  };
}

export function getMirrorRingIndex(nowMs: number, intervalMs: number, maxReports: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) intervalMs = 1;
  if (!Number.isFinite(maxReports) || maxReports <= 0) maxReports = 1;
  const bucket = Math.floor(nowMs / intervalMs);
  return ((bucket % maxReports) + maxReports) % maxReports;
}

export function addMirrorBreadcrumb(
  message: string,
  data?: Record<string, unknown>,
  context?: MirrorLogContext,
  level: 'info' | 'warning' | 'error' | 'debug' = 'info'
) {
  // Best-effort: breadcrumbs aren't guaranteed to persist across async boundaries,
  // but they will show up when a scope is still active.
  try {
    const breadcrumbData: Record<string, unknown> = {
      ...data,
      ...(context?.mirrorCmdId ? { mirror_cmd_id: context.mirrorCmdId } : {}),
    };
    Sentry.addBreadcrumb({
      category: 'mirror',
      message: truncateString(message, 200) ?? message,
      level,
      data: breadcrumbData,
    });
  } catch {
    // Never let logging break mirror execution.
  }
}

export function captureMirrorException(
  error: unknown,
  context: MirrorLogContext,
  extra?: Record<string, unknown>
) {
  const err = error instanceof Error ? error : new Error(String(error));
  try {
    Sentry.withScope((scope) => {
      // Keep tags bounded; avoid unbounded payload in tags.
      const tags: Record<string, string> = {};
      if (context.requestId) tags.request_id = truncateString(context.requestId, MAX_TAG_VALUE_LEN) ?? context.requestId;
      if (context.operation) tags.mirror_operation = truncateString(context.operation, MAX_TAG_VALUE_LEN) ?? context.operation;
      if (context.mirrorCmdId) tags.mirror_cmd_id = truncateString(context.mirrorCmdId, MAX_TAG_VALUE_LEN) ?? context.mirrorCmdId;
      if (context.showId !== undefined) tags.show_id = truncateString(String(context.showId), MAX_TAG_VALUE_LEN) ?? String(context.showId);
      if (context.djId) tags.dj_id = truncateString(context.djId, MAX_TAG_VALUE_LEN) ?? context.djId;
      if (context.route) tags.route = truncateString(context.route, MAX_TAG_VALUE_LEN) ?? context.route;
      if (context.method) tags.method = truncateString(context.method, MAX_TAG_VALUE_LEN) ?? context.method;
      if (context.httpStatus !== undefined) tags.http_status = String(context.httpStatus);
      if (context.attempt !== undefined) tags.attempt = String(context.attempt);
      if (context.maxAttempts !== undefined) tags.max_attempts = String(context.maxAttempts);
      if (context.mirrorFeatureEnabled !== undefined) tags.mirror_feature_enabled = String(context.mirrorFeatureEnabled);

      scope.setTags(tags);

      // Avoid huge extras. Truncate common large fields defensively.
      const safeExtra: Record<string, unknown> = {};
      if (extra) {
        for (const [k, v] of Object.entries(extra)) {
          if (typeof v === 'string') {
            safeExtra[k] = truncateString(v, MAX_STRING_LEN_DEFAULT) ?? v;
          } else {
            safeExtra[k] = v;
          }
        }
      }

      scope.setExtra('mirror', safeExtra);
      scope.setExtra('error_message', truncateString(err.message, MAX_STRING_LEN_DEFAULT) ?? err.message);
      Sentry.captureException(err);
    });
  } catch {
    // Never let logging break mirror execution.
  }
}

export function truncateForMirrorPayload(input: unknown, maxLen = MAX_STRING_LEN_DEFAULT): string | undefined {
  return truncateString(input, maxLen);
}

export function buildMirrorCommandSummary(cmd: {
  id: string;
  enqueuedAt: number;
  attempts: number;
  status: MirrorCommandStatus;
  lastError?: string;
  sqlLength: number;
  sqlHash: string;
  statementsCount: number;
  context?: MirrorLogContext;
}): MirrorCommandSummary {
  return {
    id: cmd.id,
    enqueuedAt: cmd.enqueuedAt,
    attempts: cmd.attempts,
    status: cmd.status,
    lastError: truncateString(cmd.lastError, MAX_STRING_LEN_DEFAULT),
    sqlLength: cmd.sqlLength,
    sqlHash: cmd.sqlHash,
    statementsCount: cmd.statementsCount,
    context: cmd.context,
  };
}

