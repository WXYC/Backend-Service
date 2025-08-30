import { NextFunction, Request, Response } from "express";
import { MirrorCommandQueue } from "./commandqueue.mirror.js";
import { MySql2Database } from "drizzle-orm/mysql2";

export type LegacyBackendFunction = {
      method: (db: MySql2Database) => Promise<unknown>;
      label?: string;
    };

export const createBackendMirrorMiddleware =
  <T>(createCommand: (req: Request, data: T) => LegacyBackendFunction[]) =>
  async (req: Request, res: Response, next: NextFunction) => {
    tapJsonResponse(res, (body) => {
      (res.locals as any).mirrorData = body;
    });

    // After the response is sent, decide whether to enqueue work
    res.once("finish", () => {
      console.log("Response finished, checking for mirror work...");
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      const data = (res.locals as any).mirrorData as T | undefined;

      console.log("Response status:", res.statusCode, "ok?", ok);
      console.log("Response data:", data);

      //if (!ok || data == null) return;

      console.log("Enqueuing mirror work...");

      const queue = MirrorCommandQueue.instance();
      queue.enqueue(createCommand(req, data!));
    });

    next();
  };


function tapJsonResponse(res: Response, onBody: (body: unknown) => void) {
  const origSend = res.send.bind(res);

  res.send = ((body?: any) => {
    let captured: unknown = body;

    const ct = (res.getHeader("content-type") || "").toString().toLowerCase();
    if (typeof body === "string" && ct.includes("application/json")) {
      try {
        captured = JSON.parse(body);
      } catch {
        // ignore parse errors; keep raw string
      }
    }

    if (Buffer.isBuffer(body) && ct.includes("application/json")) {
      try {
        captured = JSON.parse(body.toString("utf8"));
      } catch {
        /* ignore */
      }
    }
    (res.locals as any).mirrorData = captured;
    return origSend(body);
  }) as any;
}