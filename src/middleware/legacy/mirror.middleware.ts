import { NextFunction, Request, Response } from "express";
import { MirrorCommandQueue } from "./commandqueue.mirror.js";

export const createBackendMirrorMiddleware =
  (createCommand: (req: Request) => string) =>
  async (req: Request, res: Response, next: NextFunction) => {
    let queue = MirrorCommandQueue.instance();

    MirrorCommandQueue.instance().enqueue(createCommand(req));

    if (queue.isAlive()) {
      next();
    } else {
      res
        .status(503)
        .json({ message: "Service Unavailable: Mirror backend is offline" });
    }
  };
