import type { MySql2Database } from "drizzle-orm/mysql2";
import { promises } from "fs";
import { EventEmitter } from "node:events";
import path from "path";
import { LegacyBackendFunction } from "./middleware.mirror.js";
import { MirrorSQL } from "./sql.mirror.js";
import {
  createTrigger,
  cryptoRandomId,
  expBackoffMs,
} from "./utilities.mirror.js";

export interface MirrorCommand {
  id: string;
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

  cmd: (db: MySql2Database) => Promise<unknown>;
}

type MirrorCommandReport = Omit<MirrorCommand, "cmd">;

export interface MirrorQueueOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  jitterMs?: number;
  logFile?: string;
}

export interface FatalInfo {
  failedCommand: MirrorCommandReport & { run?: undefined };
  pendingQueue: Array<MirrorCommandReport & { run?: undefined }>;
  reason: string;
  timestamp: string;
  logFile: string;
}

export class MirrorCommandQueue extends EventEmitter {
  private static _instance: MirrorCommandQueue | null = null;

  static instance(options?: MirrorQueueOptions) {
    if (!this._instance) {
      this._instance = new MirrorCommandQueue(options);

      this._instance.on("enqueued", createTrigger("syncStarted"));
      this._instance.on("started", createTrigger("syncProgress"));
      this._instance.on("succeeded", createTrigger("syncComplete"));
      this._instance.on("failedAttempt", createTrigger("syncRetry"));
      this._instance.on("fatal", createTrigger("syncError"));
      this._instance.on("persisted", createTrigger("syncError"));
    }

    return this._instance;
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
      logFile: options?.logFile ?? path.resolve(process.cwd(), "mirror-logs"),
    };
  }

  enqueue(actions: Array<LegacyBackendFunction>): MirrorCommand[] | null {
    if (!this.alive) return null;

    const cmds = actions.map<MirrorCommand>((fn) => ({
      id: cryptoRandomId(),
      label: fn.label,
      enqueuedAt: Date.now(),
      attempts: 0,
      status: "pending",
      cmd: fn.method,
    }));

    for (const cmd of cmds) {
      this.queue.push(cmd);
      this.emit("enqueued", cmd);
    }

    this.kick();
    return cmds;
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
          this.emit("started", cmd);

          const res = await MirrorSQL.withDb(cmd.cmd);
          cmd.lastResult =
            typeof res === "string" ? res : JSON.stringify(res ?? null);

          cmd.status = "completed";
          this.emit("succeeded", cmd);
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
    this.emit("failedAttempt", { cmd, error: err, attempt: cmd.attempts });

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
    this.emit("fatal", info);
  }

  private async persistQueue(reason: string, failedCommand?: MirrorCommand) {
    await promises.mkdir(this.options.logFile, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = path.join(
      this.options.logFile,
      `queue-fatal-${timestamp}.json`
    );

    // Strip the non-serializable `run` before persisting
    const strip = (c: MirrorCommand) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { cmd: run, ...rest } = c;
      return rest;
    };

    const info: FatalInfo = {
      failedCommand: failedCommand
        ? strip(failedCommand)
        : ({
            id: "n/a",
            label: "n/a",
            sqlPreview: "n/a",
            status: "failed",
            enqueuedAt: 0,
            attempts: 0,
            lastResult: "n/a",
            lastError: "n/a",
          } as any),
      pendingQueue: this.queue.map(strip),
      reason,
      timestamp: new Date().toISOString(),
      logFile,
    };

    const payload = JSON.stringify(info, null, 2);
    await promises.writeFile(logFile, payload, "utf8");
    this.emit("persisted", info);
    return info;
  }
}
