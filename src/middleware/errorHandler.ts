import WxycError from '@/utils/error.js';
import { Request, Response, NextFunction } from 'express';

function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  const error = err instanceof Error ? err : new Error(String(err));

  if (error instanceof WxycError) {
    res.status(error.statusCode).json({ message: error.message });
  } else {
    res.status(500).json({ message: error.message });
  }
}

export default errorHandler;
