// db-over-ssh.ts
import { drizzle, MySql2Database } from "drizzle-orm/mysql2";
import fs from "fs";
import mysql from "mysql2/promise";
import net from "net";
import { Client as SSHClient } from "ssh2";
import { createTrigger } from "./utilities.mirror.js";

type DisposeFn = () => Promise<void>;

export class MirrorSQL {
  private static _instance: MirrorSQL | null = null;

  public db: MySql2Database | null = null;
  public disposed = false;

  private ssh: SSHClient | null = null;
  private server: net.Server | null = null;
  private localPort: number | null = null;

  private pool: mysql.Pool | null = null;

  private connections = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleMs = 5 * 60 * 1000; // 5 minutes

  private constructor() {}

  static async instance(): Promise<MirrorSQL> {
    if (!this._instance || this._instance.disposed) {
      this._instance = new MirrorSQL();
      await this._instance.start();
    }
    return this._instance;
  }

  //#region START
  private async start(): Promise<void> {
    if (this.disposed) throw new Error("Instance disposed");
    if (this.db) return; // already started

    //#region Connect over SSH tunnel
    const ssh = new SSHClient();
    const sshConfig: Parameters<SSHClient["connect"]>[0] = {
      host: process.env.SSH_HOST!,
      port: Number(process.env.SSH_PORT ?? 22),
      username: process.env.SSH_USERNAME!,
      readyTimeout: 15_000,
    };

    if (process.env.SSH_PRIVATE_KEY) {
      sshConfig.privateKey = fs.readFileSync(
        process.env.SSH_PRIVATE_KEY,
        "utf8"
      );
      if (process.env.SSH_PASSPHRASE)
        sshConfig.passphrase = process.env.SSH_PASSPHRASE;
    } else {
      sshConfig.password = process.env.SSH_PASSWORD!;
    }

    await new Promise<void>((resolve, reject) => {
      ssh
        .on("ready", () => resolve())
        .on("error", reject)
        .connect(sshConfig);
    });
    this.ssh = ssh;
    //#endregion

    //#region Local TCP server that forwards via SSH to MySQL
    const dstHost = process.env.REMOTE_DB_HOST || "127.0.0.1";
    const dstPort = Number(process.env.REMOTE_DB_PORT ?? 3306);

    const server = net.createServer((socket) => {
      ssh.forwardOut(
        socket.remoteAddress || "127.0.0.1",
        socket.remotePort || 0,
        dstHost,
        dstPort,
        (err, stream) => {
          if (err) {
            socket.destroy();
            return;
          }
          socket.pipe(stream).pipe(socket);
        }
      );
    });

    const localPort: number = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    this.server = server;
    this.localPort = localPort;
    //#endregion

    //#region mysql2 pool through the tunnel
    const pool = mysql.createPool({
      host: "127.0.0.1",
      port: localPort,
      user: process.env.REMOTE_DB_USER!,
      password: process.env.REMOTE_DB_PASSWORD!,
      database: process.env.REMOTE_DB_NAME!,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
    });

    // Optional: validate one ping early to surface creds/tunnel issues:
    await pool.query("SELECT 1");

    this.pool = pool;
    this.db = drizzle(pool, {
      logger: {
        logQuery(query: string, params: unknown[]) {
          createTrigger("sqlQuery")({ query, params });
        },
      },
    });

    this.startIdleTimer();
    //#endregion
  }
  //#endregion

  //#region INSTANCE MANAGEMENT
  async retain(): Promise<DisposeFn> {
    if (!this.db) {
      await this.start();
    }
    this.connections++;
    this.stopIdleTimer();
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await this.release();
    };
  }

  private async release(): Promise<void> {
    if (this.connections > 0) this.connections--;
    if (this.connections === 0) this.startIdleTimer();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.stopIdleTimer();

    const tasks: Promise<any>[] = [];
    if (this.pool) {
      tasks.push(
        this.pool
          .end()
          .catch((e: any) => console.warn("[MirrorSQL] pool.end warning", e))
      );
    }
    if (this.server) {
      tasks.push(
        new Promise<void>((r) => this.server!.close(() => r())).catch((e) =>
          console.warn("[MirrorSQL] server.close warning", e)
        )
      );
    }
    if (this.ssh) {
      try {
        this.ssh.end();
      } catch (e) {
        console.warn("[MirrorSQL] ssh.end warning", e);
      }
    }

    await Promise.allSettled(tasks);

    this.pool = null;
    this.db = null;
    this.server = null;
    this.localPort = null;
    this.ssh = null;

    // allow recreation
    MirrorSQL._instance = null;
  }
  //#endregion

  //#region IDLE TIMEOUT
  private startIdleTimer() {
    this.stopIdleTimer();
    if (this.idleMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      // Fire and forget; log any error
      this.dispose().catch((e) =>
        console.error("[DrizzleSshSingleton] dispose error", e)
      );
    }, this.idleMs);
  }

  private stopIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
  //#endregion

  static async withDb<T>(fn: (db: MySql2Database) => Promise<T>): Promise<T> {
    const inst = await MirrorSQL.instance();
    const release = await inst.retain();
    try {
      return await fn(inst.db!);
    } finally {
      await release();
    }
  }
}
