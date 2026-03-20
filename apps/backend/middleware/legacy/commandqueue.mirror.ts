import { EventData, MirrorEvents, serverEventsMgr } from '../../utils/serverEvents';

import { promises } from 'fs';
import { EventEmitter } from 'node:events';
import path from 'path';
import { MirrorSQL } from '@wxyc/database';
import { cryptoRandomId, expBackoffMs } from './utilities.mirror';
import {
  addMirrorBreadcrumb,
  buildMirrorCommandSummary,
  captureMirrorException,
  getMirrorRingIndex,
  hashSha256Hex,
  summarizeSql,
  type MirrorCommandSummary,
  type MirrorLogContext,
  type MirrorCommandStatus,
  truncateForMirrorPayload,
} from './mirror.logging';

const CommandQueueEvents = {
  enqueued: 'enqueued',
  started: 'started',
  succeeded: 'succeeded',
  failedAttempt: 'failedAttempt',
  fatal: 'fatal',
  persisted: 'persisted',
} as const;

export interface MirrorCommand {
  id: string;
  sql: string;
  sqlLength: number;
  sqlHash: string;
  statementsCount: number;
  enqueuedAt: number;
  attempts: number;
  lastResult?: string;
  lastError?: string;
  status: 'pending' | 'in_progress' | 'in_progress_retrying' | 'completed' | 'failed';
  context?: MirrorLogContext;
}

export interface MirrorQueueOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterMs?: number;
  logFile?: string;
}

export interface FatalInfo {
  failedCommand: MirrorCommandSummary;
  pendingQueue: MirrorCommandSummary[];
  pendingQueueDepth: number;
  reason: string;
  timestamp: string;
  logFile: string;
  ringIndex: number;
}

export class MirrorCommandQueue extends EventEmitter {
  private static _instance: MirrorCommandQueue | null = null;

  static instance(options?: MirrorQueueOptions) {
    if (!this._instance) {
      this._instance = new MirrorCommandQueue(options);

      this._instance.on(CommandQueueEvents.enqueued, this.createTrigger('syncStarted'));
      this._instance.on(CommandQueueEvents.started, this.createTrigger('syncProgress'));
      this._instance.on(CommandQueueEvents.succeeded, this.createTrigger('syncComplete'));
      this._instance.on(CommandQueueEvents.failedAttempt, this.createTrigger('syncRetry'));
      this._instance.on(CommandQueueEvents.fatal, this.createTrigger('syncError'));
      this._instance.on(CommandQueueEvents.persisted, this.createTrigger('syncError'));
    }

    return this._instance;
  }

  private static createTrigger =
    (eventType: keyof typeof MirrorEvents) =>
    (payload: MirrorCommand | { cmd: MirrorCommand; error: Error; attempt: number } | FatalInfo) => {
      const data: EventData = {
        type: eventType,
        payload,
        timestamp: new Date(),
      };

      serverEventsMgr.broadcast('mirror', data);

      // Best-effort breadcrumbs for debugging; don't let this crash the queue.
      try {
        if ('cmd' in payload) {
          const ctx = payload.cmd.context ?? {};
          addMirrorBreadcrumb(
            'Mirror sync: retry/failure attempt',
            {
              eventType,
              mirror_cmd_id: payload.cmd.id,
              attempt: payload.attempt,
              last_error: truncateForMirrorPayload(payload.error?.message, 256),
            },
            ctx,
            payload.attempt >= 2 ? 'warning' : 'info'
          );
          return;
        }

        if ('id' in payload && 'status' in payload) {
          const ctx = payload.context ?? {};
          addMirrorBreadcrumb(
            `Mirror sync: ${eventType}`,
            {
              eventType,
              mirror_cmd_id: payload.id,
              status: payload.status,
              attempt: payload.attempts,
            },
            ctx,
            eventType === 'syncError' ? 'error' : 'info'
          );
          return;
        }

        // FatalInfo
        addMirrorBreadcrumb(
          `Mirror sync: ${eventType}`,
          {
            eventType,
            ringFile: payload.logFile,
            reason: truncateForMirrorPayload(payload.reason, 256),
          },
          payload.failedCommand.context,
          'error'
        );
      } catch {
        // ignore
      }
    };

  private readonly options: Required<MirrorQueueOptions>;
  private readonly queue: MirrorCommand[] = [];
  private working = false;
  private alive = true;
  private fatalEmitted = false;

  private constructor(options?: MirrorQueueOptions) {
    super();
    this.options = {
      maxAttempts: options?.maxAttempts ?? 5,
      baseBackoffMs: options?.baseBackoffMs ?? 250,
      maxBackoffMs: options?.maxBackoffMs ?? 30_000,
      jitterMs: options?.jitterMs ?? 0.2,
      logFile: options?.logFile ?? path.resolve(process.cwd(), 'mirror-logs'),
    };
  }

  enqueue(sqls: string[], context?: MirrorLogContext): MirrorCommand | null {
    if (!this.alive) return null;
    let sql = sqls.map((s) => (s.trim().endsWith(';') ? s.trim() : s.trim() + ';')).join('\n');
    sql = `START TRANSACTION;\n${sql}\nCOMMIT;`;

    const sqlSummary = summarizeSql(sql);
    const cmd: MirrorCommand = {
      id: cryptoRandomId(),
      sql,
      sqlLength: sqlSummary.sqlLength,
      sqlHash: sqlSummary.sqlHash ?? hashSha256Hex(sql),
      statementsCount: sqls.length,
      enqueuedAt: Date.now(),
      attempts: 0,
      status: 'pending',
      context,
    };

    this.queue.push(cmd);
    this.emit(CommandQueueEvents.enqueued, cmd);
    this.kick();
    return cmd;
  }

  isAlive() {
    return this.alive;
  }
  isDead() {
    return !this.alive;
  }

  getState() {
    return {
      alive: this.alive,
      working: this.working,
      depth: this.queue.length,
      maxAttempts: this.options.maxAttempts,
    };
  }

  // INTERNAL

  private kick() {
    if (!this.working && this.alive) {
      void this.workLoop();
    }
  }

  private async workLoop() {
    this.working = true;
    try {
      while (this.alive && this.queue.length > 0) {
        const cmd = this.queue.shift()!;

        try {
          cmd.attempts += 1;
          cmd.status = 'in_progress';
          this.emit(CommandQueueEvents.started, cmd);

          cmd.lastResult = await MirrorSQL.instance().send(cmd.sql);

          cmd.status = 'completed';
          this.emit(CommandQueueEvents.succeeded, cmd);
        } catch (err) {
          cmd.status = 'failed';
          cmd.lastError = String((err as Error).message || err);
          await this.handleFailure(cmd, err as Error);
        }
      }
    } finally {
      this.working = false;
    }
  }

  private async handleFailure(cmd: MirrorCommand, err: Error) {
    cmd.lastError = err.message ?? String(err);
    this.emit(CommandQueueEvents.failedAttempt, { cmd, error: err, attempt: cmd.attempts });

    if (cmd.attempts >= this.options.maxAttempts) {
      await this.fatalStop(cmd, `Exceeded maxAttempts=${this.options.maxAttempts}`);
      return;
    }

    // Secondary reports: first failure (or configurable attempt) to disk; bounded ring-buffer.
    try {
      const secondaryAttempt = parseInt(process.env.MIRROR_SECONDARY_REPORT_ON_ATTEMPT ?? '1', 10);
      const maxSecondaryReports = parseInt(process.env.MIRROR_SECONDARY_REPORTS_MAX ?? '10', 10);
      const secondaryIntervalMs = parseInt(process.env.MIRROR_SECONDARY_REPORTS_INTERVAL_MS ?? String(10 * 60 * 1000), 10);
      if (cmd.attempts === secondaryAttempt && maxSecondaryReports > 0) {
        void this.persistSecondaryReport({
          cmd,
          err,
          attempt: cmd.attempts,
          maxSecondaryReports,
          secondaryIntervalMs,
        });
      }
    } catch {
      // ignore
    }

    cmd.status = 'in_progress_retrying';
    const delay = expBackoffMs(
      cmd.attempts,
      this.options.baseBackoffMs,
      this.options.maxBackoffMs,
      this.options.jitterMs
    );

    addMirrorBreadcrumb(
      'Mirror sync: retry scheduled',
      {
        mirror_cmd_id: cmd.id,
        attempt: cmd.attempts,
        delay_ms: delay,
        last_error: truncateForMirrorPayload(cmd.lastError, 256),
      },
      cmd.context,
      'warning'
    );

    setTimeout(() => {
      if (this.alive) {
        this.queue.unshift(cmd);
        this.kick();
      } else {
        this.queue.push(cmd);
      }
    }, delay);
  }

  private async fatalStop(failedCommand: MirrorCommand, reason: string) {
    if (this.fatalEmitted) return;
    this.fatalEmitted = true;
    this.alive = false;

    const ctx: MirrorLogContext = {
      ...(failedCommand.context ?? {}),
      operation: failedCommand.context?.operation ?? 'mirror.fatal',
      mirrorCmdId: failedCommand.id,
      attempt: failedCommand.attempts,
      maxAttempts: this.options.maxAttempts,
    };

    captureMirrorException(new Error(failedCommand.lastError ?? reason), ctx, {
      reason,
      mirror_cmd_id: failedCommand.id,
      sqlLength: failedCommand.sqlLength,
      sqlHash: failedCommand.sqlHash,
      statementsCount: failedCommand.statementsCount,
    });

    const info = await this.persistQueue(reason, failedCommand);
    this.emit(CommandQueueEvents.fatal, info);
  }

  private async persistSecondaryReport(params: {
    cmd: MirrorCommand;
    err: Error;
    attempt: number;
    maxSecondaryReports: number;
    secondaryIntervalMs: number;
  }) {
    const nowMs = Date.now();
    await promises.mkdir(this.options.logFile, { recursive: true });
    const ringIndex = getMirrorRingIndex(nowMs, params.secondaryIntervalMs, params.maxSecondaryReports);
    const logFile = path.join(this.options.logFile, `queue-secondary-ring-${ringIndex}.json`);

    const payload = {
      reportType: 'secondary',
      ringIndex,
      timestamp: new Date(nowMs).toISOString(),
      logFile,
      attempt: params.attempt,
      reason: 'Mirror failedAttempt; retry scheduled',
      cmd: buildMirrorCommandSummary(params.cmd),
      error: truncateForMirrorPayload(params.err?.message ?? String(params.err), 2048),
    };

    // Keep disk report bounded: ensure we never write huge JSON strings.
    // If too large, write a smaller summary payload.
    const maxJsonBytes = parseInt(process.env.MIRROR_REPORT_MAX_BYTES ?? String(64 * 1024), 10);
    const fullJson = JSON.stringify(payload);
    let boundedJson = fullJson;

    if (fullJson.length > maxJsonBytes) {
      boundedJson = JSON.stringify({
        reportType: 'secondary',
        ringIndex,
        timestamp: payload.timestamp,
        logFile: payload.logFile,
        attempt: payload.attempt,
        reason: payload.reason,
        // Strip context to keep the report small.
        cmd: { ...payload.cmd, context: undefined },
        error: payload.error,
        truncated: true,
        jsonBytes: fullJson.length,
      });
    }

    await promises.writeFile(logFile, boundedJson, 'utf8');
    addMirrorBreadcrumb('Mirror sync: secondary report persisted', { ringIndex, logFile }, params.cmd.context, 'info');
  }

  private async persistQueue(reason: string, failedCommand?: MirrorCommand) {
    await promises.mkdir(this.options.logFile, { recursive: true });

    const nowMs = Date.now();
    const maxFatalReports = parseInt(process.env.MIRROR_FATAL_REPORTS_MAX ?? '10', 10);
    const fatalIntervalMs = parseInt(process.env.MIRROR_FATAL_REPORTS_INTERVAL_MS ?? String(15 * 60 * 1000), 10);
    const ringIndex = getMirrorRingIndex(nowMs, fatalIntervalMs, maxFatalReports);
    const logFile = path.join(this.options.logFile, `queue-fatal-ring-${ringIndex}.json`);

    const failedCmdSummary = failedCommand
      ? buildMirrorCommandSummary(failedCommand)
      : ({
          id: 'n/a',
          enqueuedAt: 0,
          attempts: 0,
          status: 'failed',
          lastError: 'n/a',
          sqlLength: 0,
          sqlHash: 'n/a',
          statementsCount: 0,
        } satisfies MirrorCommandSummary);

    const maxPendingSummaries = parseInt(process.env.MIRROR_PENDING_QUEUE_SUMMARIES_MAX ?? '20', 10);
    const pendingQueue = this.queue.slice(0, maxPendingSummaries).map((c) => buildMirrorCommandSummary(c));

    const info: FatalInfo = {
      failedCommand: failedCmdSummary,
      pendingQueue,
      pendingQueueDepth: this.queue.length,
      reason: truncateForMirrorPayload(reason, 2048) ?? reason,
      timestamp: new Date(nowMs).toISOString(),
      logFile,
      ringIndex,
    };

    const maxJsonBytes = parseInt(process.env.MIRROR_REPORT_MAX_BYTES ?? String(64 * 1024), 10);

    const fullJson = JSON.stringify(info);
    let boundedJson = fullJson;

    if (fullJson.length > maxJsonBytes) {
      boundedJson = JSON.stringify({
        reportType: 'fatal',
        ringIndex,
        timestamp: info.timestamp,
        logFile: info.logFile,
        reason: info.reason,
        failedCommand: { ...info.failedCommand, context: undefined },
        pendingQueueDepth: info.pendingQueueDepth,
        truncated: true,
        jsonBytes: fullJson.length,
      });
    }

    await promises.writeFile(logFile, boundedJson, 'utf8');
    this.emit(CommandQueueEvents.persisted, info);
    return info;
  }
}
