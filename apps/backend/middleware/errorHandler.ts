import WxycError from '../utils/error.js';
import { Request, Response, NextFunction } from 'express';

function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  // prettier-ignore
  const error = err instanceof Error
    ? err
    : new Error(String(err));

  if (error instanceof WxycError) {
    console.error(`[${req.method} ${req.url}] WxycError ${error.statusCode}: ${error.message}`);
    res.status(error.statusCode).json({ message: error.message });
  } else {
    console.error(`[${req.method} ${req.url}] Unhandled error:`, error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

export default errorHandler;
