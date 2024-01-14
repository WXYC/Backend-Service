import { Request, Response } from 'express';

function errorHandler(err: Error, req: Request, res: Response) {
  res.json({ status: res.status, message: err.message ?? 'Internal Server Error' });
}

export default errorHandler;
