import { Request, Response, NextFunction, RequestHandler } from 'express';
import * as flowsheet_service from '../services/flowsheet.service.js';

/**
 * Middleware that handles conditional GET requests for flowsheet endpoints.
 *
 * Supports two methods for conditional requests:
 * - `since` query param: UNIX epoch milliseconds (e.g., `?since=1737208800000`)
 * - `If-Modified-Since` header: HTTP-date format (per RFC 7232)
 *
 * Returns 304 Not Modified if data hasn't changed since the client's timestamp.
 *
 * Response headers:
 * - `Last-Modified`: HTTP-date format (per RFC 7232)
 * - `X-Last-Modified-Epoch`: UNIX epoch milliseconds for easy client use
 */
export const conditionalGet: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const lastModified = flowsheet_service.getLastModifiedAt();
  const lastModifiedEpoch = lastModified.getTime();

  // Check query param (epoch ms) first, then header (HTTP-date)
  const sinceParam = req.query.since as string | undefined;
  const sinceHeader = req.get('If-Modified-Since');

  let clientTime: Date | null = null;

  if (sinceParam) {
    // Parse as epoch milliseconds
    const epochMs = parseInt(sinceParam, 10);
    if (!isNaN(epochMs)) {
      clientTime = new Date(epochMs);
    }
  } else if (sinceHeader) {
    // Parse as HTTP-date format
    clientTime = new Date(sinceHeader);
  }

  if (clientTime && !isNaN(clientTime.getTime()) && clientTime >= lastModified) {
    res.status(304).end();
    return;
  }

  // Set headers for client to use in future requests
  res.set('Last-Modified', lastModified.toUTCString());
  res.set('X-Last-Modified-Epoch', lastModifiedEpoch.toString());
  next();
};
