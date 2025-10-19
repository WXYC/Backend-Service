import {
  EventData,
  MirrorEvents,
  serverEventsMgr,
} from "@wxyc/shared";

import { promises } from "fs";
import { EventEmitter } from "node:events";
import path from "path";
import { MirrorSQL } from "./sql.mirror.js";
import { cryptoRandomId, expBackoffMs } from "./utilities.mirror.js";

const CommandQueueEvents = {
  enqueued: "enqueued",
  started: "started",
  succeeded: "succeeded",
  failedAttempt: "failedAttempt",
  fatal: "fatal",
  persisted: "persisted",
} as const;

export interface MirrorCommand {
  id: string;
  sql: string;
  enqueuedAt: number;
  attempts: number;
  lastResult?: string;
  lastError?: string;
  status:
    | "pending"
    | "in_progress"
    | "in_progress_retrying"
    | "completed"
    | "failed";
}

export interface MirrorQueueOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterMs?: number;
  logFile?: string;
}

export interface FatalInfo {
  failedCommand: MirrorCommand;
  pendingQueue: MirrorCommand[];
  reason: string;
  timestamp: string;
  logFile: string;
}

export class MirrorCommandQueue extends EventEmitter {
  private static _instance: MirrorCommandQueue | null = null;

  static instance(options?: MirrorQueueOptions) {
    if (!this._instance) {
      this._instance = new MirrorCommandQueue(options);

      this._instance.on(CommandQueueEvents.enqueued, this.createTrigger("syncStarted"));
      this._instance.on(CommandQueueEvents.started, this.createTrigger("syncProgress"));
      this._instance.on(CommandQueueEvents.succeeded, this.createTrigger("syncComplete"));
      this._instance.on(CommandQueueEvents.failedAttempt, this.createTrigger("syncRetry"));
      this._instance.on(CommandQueueEvents.fatal, this.createTrigger("syncError"));
      this._instance.on(CommandQueueEvents.persisted, this.createTrigger("syncError"));
    }

    return this._instance;
  }

  private static createTrigger =
    (eventType: keyof typeof MirrorEvents) => async (cmd: MirrorCommand) => {
      const data: EventData = {
        type: eventType,
        payload: cmd,
        timestamp: new Date(),
      };

      serverEventsMgr.broadcast("mirror", data);
      console.table(cmd);
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
      logFile: options?.logFile ?? path.resolve(process.cwd(), "mirror-logs"),
    };
  }

  enqueue(sqls: string[]): MirrorCommand | null {
    if (!this.alive) return null;
    let sql = sqls
      .map((s) => (s.trim().endsWith(";") ? s.trim() : s.trim() + ";"))
      .join("\n");
    sql = `START TRANSACTION;\n${sql}\nCOMMIT;`;

    const cmd: MirrorCommand = {
      id: cryptoRandomId(),
      sql,
      enqueuedAt: Date.now(),
      attempts: 0,
      status: "pending",
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
          cmd.status = "in_progress";
          this.emit(CommandQueueEvents.started, cmd);

          cmd.lastResult = await MirrorSQL.instance().send(cmd.sql);

          cmd.status = "completed";
          this.emit(CommandQueueEvents.succeeded, cmd);
        } catch (err) {
          cmd.status = "failed";
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
      await this.fatalStop(
        cmd,
        `Exceeded maxAttempts=${this.options.maxAttempts}`
      );
      return;
    }

    cmd.status = "in_progress_retrying";
    const delay = expBackoffMs(
      cmd.attempts,
      this.options.baseBackoffMs,
      this.options.maxBackoffMs,
      this.options.jitterMs
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

    const info = await this.persistQueue(reason, failedCommand);
    this.emit(CommandQueueEvents.fatal, info);
  }

  private async persistQueue(reason: string, failedCommand?: MirrorCommand) {
    await promises.mkdir(this.options.logFile, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = path.join(
      this.options.logFile,
      `queue-fatal-${timestamp}.json`
    );

    const info: FatalInfo = {
      failedCommand: failedCommand ?? {
        id: "n/a",
        sql: "n/a",
        status: "failed",
        enqueuedAt: 0,
        attempts: 0,
        lastResult: "n/a",
        lastError: "n/a",
      },
      pendingQueue: [...this.queue],
      reason,
      timestamp: new Date().toISOString(),
      logFile,
    };

    const payload = JSON.stringify(info, null, 2);
    await promises.writeFile(logFile, payload, "utf8");
    this.emit(CommandQueueEvents.persisted, info);
    return info;
  }
}
