import WxycError from '../utils/error.js';
import { LmlClientError } from '@wxyc/lml-client';
import { Request, Response, NextFunction } from 'express';

function hasStatusCode(error: Error): error is WxycError | LmlClientError {
  return error instanceof WxycError || error instanceof LmlClientError;
}

function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  // prettier-ignore
  const error = err instanceof Error
    ? err
    : new Error(String(err));

  if (hasStatusCode(error)) {
    console.error(`[${req.method} ${req.url}] ${error.name} ${error.statusCode}: ${error.message}`);
    res.status(error.statusCode).json({ message: error.message });
  } else {
    console.error(`[${req.method} ${req.url}] Unhandled error:`, error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

export default errorHandler;
