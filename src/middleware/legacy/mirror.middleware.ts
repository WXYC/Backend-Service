import { NextFunction, Request, Response } from "express";
import { MirrorCommandQueue } from "./commandqueue.mirror.js";

import { PostHog } from "posthog-node";

export const createBackendMirrorMiddleware =
  <T>(createCommand: (req: Request, data: T) => Promise<string[]>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    tapJsonResponse(res);

    // After the response is sent, decide whether to enqueue work
    res.once("finish", async () => {
      try {
        
        const postHogClient = new PostHog(process.env.POSTHOG_API_KEY ?? "", {
          host: "https://us.i.posthog.com",
        });

        console.log("Response finished, checking for mirror work...");
        const ok = res.statusCode >= 200 && res.statusCode < 305;
        const data = (res.locals as any).mirrorData as T | undefined;

        console.log("Response status:", res.statusCode, "ok?", ok);

        const distinctId = (req as any).user?.id ?? req.ip ?? "anonymous";
        if (
          !ok ||
          data == null ||
          (await postHogClient.isFeatureEnabled(distinctId, 'backend-mirror'))
        )
          return;

        console.log("Enqueuing mirror work...");

        const queue = MirrorCommandQueue.instance();
        queue.enqueue(await createCommand(req, data));

        await postHogClient.shutdown();
      } catch (e) {
        console.error("Error in mirror middleware:", e);
      }
    });

    next();
  };

function tapJsonResponse(res: Response) {
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
