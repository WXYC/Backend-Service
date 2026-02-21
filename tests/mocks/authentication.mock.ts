import { Request, Response, NextFunction } from 'express';

export function requirePermissions(_required: Record<string, string[]>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Unauthorized: Missing Authorization header.' });
    }
    return next();
  };
}
