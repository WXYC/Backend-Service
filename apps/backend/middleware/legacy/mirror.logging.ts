import * as Sentry from '@sentry/node';
import crypto from 'crypto';

export type MirrorLogContext = {
  requestId?: string;
  mirrorCmdId?: string;
  attempt?: number;
  maxAttempts?: number;
  extra?: Record<string, unknown>;
};

export type MirrorCommandStatus = 'pending' | 'in_progress' | 'in_progress_retrying' | 'completed' | 'failed';

export type MirrorCommandSummary = {
  id: string;
  enqueuedAt: number;
  attempts: number;
  status: MirrorCommandStatus;
  lastError?: string;
  sqlLength: number;
  sqlHash: string;
  statementsCount: number;
  context?: MirrorLogContext;
};

const MAX_STRING_LEN_DEFAULT = 1024;
const MAX_TAG_VALUE_LEN = 64;

function truncateString(input: unknown, maxLen: number): string | undefined {
  if (input === undefined || input === null) return undefined;
  const s = typeof input === 'string' ? input : String(input);
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

export function hashSha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function summarizeSql(sql: string): { sqlLength: number; sqlHash: string } {
  return {
    sqlLength: sql.length,
    sqlHash: hashSha256Hex(sql),
  };
}

export function getMirrorRingIndex(nowMs: number, intervalMs: number, maxReports: number): number {
  const safeInterval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 1;
  const safeMax = Number.isFinite(maxReports) && maxReports > 0 ? Math.floor(maxReports) : 1;
  const bucket = Math.floor(nowMs / safeInterval);
  return ((bucket % safeMax) + safeMax) % safeMax;
}

export function addMirrorBreadcrumb(
  message: string,
  data?: Record<string, unknown>,
  context?: MirrorLogContext,
  level: 'info' | 'warning' | 'error' | 'debug' = 'info'
): void {
  try {
    const breadcrumbData: Record<string, unknown> = {
      ...data,
      ...(context?.mirrorCmdId ? { mirror_cmd_id: context.mirrorCmdId } : {}),
      ...(context?.requestId ? { request_id: context.requestId } : {}),
    };
    Sentry.addBreadcrumb({
      category: 'mirror',
      message: truncateString(message, 200) ?? message,
      level,
      data: breadcrumbData,
    });
  } catch {
    // Never let observability break mirror execution.
  }
}

export function captureMirrorException(
  error: unknown,
  context: MirrorLogContext,
  extra?: Record<string, unknown>
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  try {
    Sentry.withScope((scope) => {
      const tags: Record<string, string> = { subsystem: 'legacy-mirror' };
      if (context.requestId) tags.request_id = truncateString(context.requestId, MAX_TAG_VALUE_LEN)!;
      if (context.mirrorCmdId) tags.mirror_cmd_id = truncateString(context.mirrorCmdId, MAX_TAG_VALUE_LEN)!;
      if (context.attempt !== undefined) tags.attempt = String(context.attempt);
      if (context.maxAttempts !== undefined) tags.max_attempts = String(context.maxAttempts);
      scope.setTags(tags);

      const safeExtra: Record<string, unknown> = {};
      if (extra) {
        for (const [k, v] of Object.entries(extra)) {
          safeExtra[k] = typeof v === 'string' ? truncateString(v, MAX_STRING_LEN_DEFAULT) : v;
        }
      }
      scope.setExtra('mirror', safeExtra);
      scope.setExtra('error_message', truncateString(err.message, MAX_STRING_LEN_DEFAULT));
      Sentry.captureException(err);
    });
  } catch {
    // Never let observability break mirror execution.
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
