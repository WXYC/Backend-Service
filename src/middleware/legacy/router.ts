import { Router } from "express";
import { sseBroker } from "./sse.js";

export const legacyBackendEventsRouter = Router();

legacyBackendEventsRouter.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  sseBroker.add(res);
  res.write(
    `event: ready\ndata: ${JSON.stringify({ clients: sseBroker.size() })}\n\n`
  );

  const interval = setInterval(
    () => res.write(`event: ping\ndata: {}\n\n`),
    15000
  );

  req.on("close", () => {
    clearInterval(interval);
    sseBroker.remove(res);
    res.end();
  });
});
