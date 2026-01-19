import { Request, Response, NextFunction, RequestHandler } from 'express';
import * as flowsheet_service from '../services/flowsheet.service.js';

/**
 * Middleware that handles conditional GET requests for flowsheet endpoints.
 * Supports both `since` query param and `If-Modified-Since` header.
 * Returns 304 Not Modified if data hasn't changed since the client's timestamp.
 * Sets `Last-Modified` header on responses for client caching.
 */
export const conditionalGet: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const lastModified = flowsheet_service.getLastModifiedAt();

  // Check query param first, then header
  const sinceParam = req.query.since as string | undefined;
  const sinceHeader = req.get('If-Modified-Since');
  const sinceStr = sinceParam || sinceHeader;

  if (sinceStr) {
    const clientTime = new Date(sinceStr);
    if (!isNaN(clientTime.getTime()) && clientTime >= lastModified) {
      res.status(304).end();
      return;
    }
  }

  // Set Last-Modified header for client to use in future requests
  res.set('Last-Modified', lastModified.toUTCString());
  next();
};
