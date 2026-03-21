import WxycError from '../utils/error.js';
import { Request, Response, NextFunction } from 'express';

function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  // prettier-ignore
  const error = err instanceof Error 
    ? err 
    : new Error(String(err));

  if (error instanceof WxycError) {
    res.status(error.statusCode).json({ message: error.message });
  } else {
    console.error('Unhandled error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
}

export default errorHandler;
