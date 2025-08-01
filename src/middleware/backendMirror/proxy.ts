import { Request, Response, NextFunction } from "express";
import { Backend, Transform } from "./types.js";

export const proxy =
  <I = any, O = any>(transform: Transform<I, O>, backend: Backend<O>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = transform(req.body as I, req);
      const { status, data } = await backend(payload, req);
      res.status(status).json(data);
    } catch (err) {
      next(err);
    }
  };