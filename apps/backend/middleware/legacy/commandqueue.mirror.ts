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
  summarizeSql,
  truncateForMirrorPayload,
  type MirrorCommandStatus,
  type MirrorCommandSummary,
  type MirrorLogContext,
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
  status: MirrorCommandStatus;
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

/**
 * Internal payload for `createTrigger`. Tagged so each branch is exhaustive
 * and survives future field additions; the wire shape sent to SSE consumers
 * stays the bare `MirrorCommand` / `FatalInfo` for backwards compatibility.
 */
type TriggerPayload =
  | { kind: 'command'; cmd: MirrorCommand }
  | { kind: 'retry'; cmd: MirrorCommand; error: Error; attempt: number }
  | { kind: 'fatal'; info: FatalInfo };

const DEFAULTS = {
  fatalReportsMax: 10,
  fatalReportsIntervalMs: 15 * 60 * 1000,
  secondaryReportsMax: 10,
  secondaryReportsIntervalMs: 10 * 60 * 1000,
  secondaryReportOnAttempt: 1,
  reportMaxBytes: 64 * 1024,
  pendingQueueSummariesMax: 20,
} as const;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export class MirrorCommandQueue extends EventEmitter {
  private static _instance: MirrorCommandQueue | null = null;

  /**
   * Get the process-wide mirror queue. Auto-recycles after `fatalStop`:
   * if the prior singleton went dead (5 failed attempts on any command
   * tripped `fatalStop`, flipping `alive=false`), the next call returns a
   * fresh live instance instead of the dead one. Without this, every
   * caller after the first fatal would see `enqueue` return `null`
   * silently for the lifetime of the process (BS#1123).
   *
   * In-flight write invariant: the dead instance's `workLoop` continues
   * to drain (or fatal-stop) on its own promise chain; the fresh queue
   * starts empty, so no command is torn between the two instances.
   */
  static instance(options?: MirrorQueueOptions) {
    if (this._instance && this._instance.isDead()) {
      this._instance = null;
    }
    if (!this._instance) {
      this._instance = new MirrorCommandQueue(options);

      this._instance.on(CommandQueueEvents.enqueued, this.dispatch('syncStarted'));
      this._instance.on(CommandQueueEvents.started, this.dispatch('syncProgress'));
      this._instance.on(CommandQueueEvents.succeeded, this.dispatch('syncComplete'));
      this._instance.on(CommandQueueEvents.failedAttempt, this.dispatch('syncRetry'));
      this._instance.on(CommandQueueEvents.fatal, this.dispatch('syncError'));
      this._instance.on(CommandQueueEvents.persisted, this.dispatch('syncError'));
    }

    return this._instance;
  }

  /**
   * Builds an EventEmitter listener for a given MirrorEvents type.
   * Wraps the raw payload (cmd / failedAttempt-tuple / FatalInfo) into a
   * tagged TriggerPayload for the breadcrumb branch, then broadcasts the
   * unwrapped, original-shape payload to SSE subscribers.
   */
  private static dispatch =
    (eventType: keyof typeof MirrorEvents) =>
    (raw: MirrorCommand | { cmd: MirrorCommand; error: Error; attempt: number } | FatalInfo) => {
      const tagged = MirrorCommandQueue.tagPayload(raw);

      // SSE wire format: keep the prior bare-shape payload to avoid breaking dj-site.
      const data: EventData = {
        type: eventType,
        payload: MirrorCommandQueue.broadcastPayload(tagged),
        timestamp: new Date(),
      };
      serverEventsMgr.broadcast('mirror', data);

      try {
        switch (tagged.kind) {
          case 'command':
            addMirrorBreadcrumb(
              `Mirror queue: ${eventType}`,
              {
                eventType,
                status: tagged.cmd.status,
                attempt: tagged.cmd.attempts,
                sql_length: tagged.cmd.sqlLength,
                sql_hash: tagged.cmd.sqlHash,
              },
              tagged.cmd.context ?? { mirrorCmdId: tagged.cmd.id },
              eventType === 'syncError' ? 'error' : 'info'
            );
            return;
          case 'retry':
            addMirrorBreadcrumb(
              'Mirror queue: failed attempt',
              {
                eventType,
                attempt: tagged.attempt,
                last_error: truncateForMirrorPayload(tagged.error?.message, 256),
              },
              tagged.cmd.context ?? { mirrorCmdId: tagged.cmd.id },
              tagged.attempt >= 2 ? 'warning' : 'info'
            );
            return;
          case 'fatal':
            addMirrorBreadcrumb(
              `Mirror queue: ${eventType}`,
              {
                eventType,
                ring_file: tagged.info.logFile,
                pending_depth: tagged.info.pendingQueueDepth,
                reason: truncateForMirrorPayload(tagged.info.reason, 256),
              },
              tagged.info.failedCommand.context,
              'error'
            );
            return;
        }
      } catch {
        // Never let observability break the queue.
      }
    };

  private static tagPayload(
    raw: MirrorCommand | { cmd: MirrorCommand; error: Error; attempt: number } | FatalInfo
  ): TriggerPayload {
    if ('failedCommand' in raw) return { kind: 'fatal', info: raw };
    if ('cmd' in raw && 'error' in raw) return { kind: 'retry', ...raw };
    return { kind: 'command', cmd: raw };
  }

  private static broadcastPayload(
    tagged: TriggerPayload
  ): MirrorCommand | FatalInfo | { cmd: MirrorCommand; error: Error; attempt: number } {
    switch (tagged.kind) {
      case 'command':
        return tagged.cmd;
      case 'retry':
        return { cmd: tagged.cmd, error: tagged.error, attempt: tagged.attempt };
      case 'fatal':
        return tagged.info;
    }
  }

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
    const joined = sqls.map((s) => (s.trim().endsWith(';') ? s.trim() : s.trim() + ';')).join('\n');
    const sql = `START TRANSACTION;\n${joined}\nCOMMIT;`;
    const { sqlLength, sqlHash } = summarizeSql(sql);

    const id = cryptoRandomId();
    const cmd: MirrorCommand = {
      id,
      sql,
      sqlLength,
      sqlHash,
      statementsCount: sqls.length,
      enqueuedAt: Date.now(),
      attempts: 0,
      status: 'pending',
      context: context ? { ...context, mirrorCmdId: id } : { mirrorCmdId: id },
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

    const secondaryAttempt = envInt('MIRROR_SECONDARY_REPORT_ON_ATTEMPT', DEFAULTS.secondaryReportOnAttempt);
    const maxSecondary = envInt('MIRROR_SECONDARY_REPORTS_MAX', DEFAULTS.secondaryReportsMax);
    if (cmd.attempts === secondaryAttempt && maxSecondary > 0) {
      // Best-effort: persistSecondaryReport handles its own errors. Awaiting it
      // is safe because it never throws — we rely on this so a disk write
      // failure can never abort the retry/re-queue path below.
      await this.persistSecondaryReport(cmd, err, maxSecondary);
    }

    cmd.status = 'in_progress_retrying';
    const delay = expBackoffMs(
      cmd.attempts,
      this.options.baseBackoffMs,
      this.options.maxBackoffMs,
      this.options.jitterMs
    );

    addMirrorBreadcrumb(
      'Mirror queue: retry scheduled',
      {
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
      mirrorCmdId: failedCommand.id,
      attempt: failedCommand.attempts,
      maxAttempts: this.options.maxAttempts,
    };

    captureMirrorException(new Error(failedCommand.lastError ?? reason), ctx, {
      reason,
      sql_length: failedCommand.sqlLength,
      sql_hash: failedCommand.sqlHash,
      statements_count: failedCommand.statementsCount,
    });

    const info = await this.persistQueue(reason, failedCommand);
    this.emit(CommandQueueEvents.fatal, info);
  }

  /**
   * Best-effort: never throws. A failed disk write degrades observability
   * (caught and surfaced as a Sentry breadcrumb) but never breaks the retry
   * loop in `handleFailure`.
   */
  private async persistSecondaryReport(cmd: MirrorCommand, err: Error, maxReports: number): Promise<void> {
    const intervalMs = envInt('MIRROR_SECONDARY_REPORTS_INTERVAL_MS', DEFAULTS.secondaryReportsIntervalMs);
    const maxBytes = envInt('MIRROR_REPORT_MAX_BYTES', DEFAULTS.reportMaxBytes);
    const nowMs = Date.now();
    const ringIndex = getMirrorRingIndex(nowMs, intervalMs, maxReports);
    const logFile = path.join(this.options.logFile, `queue-secondary-ring-${ringIndex}.json`);

    const payload = {
      reportType: 'secondary' as const,
      ringIndex,
      timestamp: new Date(nowMs).toISOString(),
      logFile,
      attempt: cmd.attempts,
      reason: 'Mirror failedAttempt; retry scheduled',
      cmd: buildMirrorCommandSummary(cmd),
      error: truncateForMirrorPayload(err?.message ?? String(err), 2048),
    };

    try {
      await promises.mkdir(this.options.logFile, { recursive: true });
      const json = boundedJson(payload, maxBytes, () => ({
        reportType: 'secondary' as const,
        ringIndex,
        timestamp: payload.timestamp,
        logFile: payload.logFile,
        attempt: payload.attempt,
        reason: payload.reason,
        cmd: { ...payload.cmd, context: undefined },
        error: payload.error,
        truncated: true,
      }));
      await promises.writeFile(logFile, json, 'utf8');
      addMirrorBreadcrumb('Mirror queue: secondary report persisted', { ringIndex, logFile }, cmd.context, 'info');
    } catch (writeErr) {
      addMirrorBreadcrumb(
        'Mirror queue: secondary report write failed',
        { ringIndex, logFile, error: truncateForMirrorPayload((writeErr as Error)?.message ?? String(writeErr), 256) },
        cmd.context,
        'warning'
      );
    }
  }

  private async persistQueue(reason: string, failedCommand?: MirrorCommand): Promise<FatalInfo> {
    const intervalMs = envInt('MIRROR_FATAL_REPORTS_INTERVAL_MS', DEFAULTS.fatalReportsIntervalMs);
    const maxReports = envInt('MIRROR_FATAL_REPORTS_MAX', DEFAULTS.fatalReportsMax);
    const maxBytes = envInt('MIRROR_REPORT_MAX_BYTES', DEFAULTS.reportMaxBytes);
    const maxPendingSummaries = envInt('MIRROR_PENDING_QUEUE_SUMMARIES_MAX', DEFAULTS.pendingQueueSummariesMax);

    const nowMs = Date.now();
    const ringIndex = getMirrorRingIndex(nowMs, intervalMs, maxReports);
    const logFile = path.join(this.options.logFile, `queue-fatal-ring-${ringIndex}.json`);

    const failedCmdSummary: MirrorCommandSummary = failedCommand
      ? buildMirrorCommandSummary(failedCommand)
      : {
          id: 'n/a',
          enqueuedAt: 0,
          attempts: 0,
          status: 'failed',
          lastError: 'n/a',
          sqlLength: 0,
          sqlHash: 'n/a',
          statementsCount: 0,
        };

    const pendingQueue = this.queue.slice(0, maxPendingSummaries).map(buildMirrorCommandSummary);

    const info: FatalInfo = {
      failedCommand: failedCmdSummary,
      pendingQueue,
      pendingQueueDepth: this.queue.length,
      reason: truncateForMirrorPayload(reason, 2048) ?? reason,
      timestamp: new Date(nowMs).toISOString(),
      logFile,
      ringIndex,
    };

    try {
      await promises.mkdir(this.options.logFile, { recursive: true });
      const json = boundedJson(info, maxBytes, () => ({
        reportType: 'fatal' as const,
        ringIndex,
        timestamp: info.timestamp,
        logFile: info.logFile,
        reason: info.reason,
        failedCommand: { ...info.failedCommand, context: undefined },
        pendingQueueDepth: info.pendingQueueDepth,
        truncated: true,
      }));
      await promises.writeFile(logFile, json, 'utf8');
    } catch (writeErr) {
      addMirrorBreadcrumb(
        'Mirror queue: fatal report write failed',
        { ringIndex, logFile, error: truncateForMirrorPayload((writeErr as Error)?.message ?? String(writeErr), 256) },
        failedCmdSummary.context,
        'error'
      );
    }

    this.emit(CommandQueueEvents.persisted, info);
    return info;
  }
}

function boundedJson<T>(payload: T, maxBytes: number, summarize: () => unknown): string {
  const full = JSON.stringify(payload);
  if (full.length <= maxBytes) return full;
  return JSON.stringify({ ...(summarize() as Record<string, unknown>), jsonBytes: full.length });
}
