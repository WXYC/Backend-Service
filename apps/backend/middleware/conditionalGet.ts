import { Request, Response, NextFunction, RequestHandler } from 'express';
import * as flowsheet_service from '../services/flowsheet.service.js';

/**
 * Middleware that handles conditional GET requests for flowsheet endpoints.
 * Supports both `since` query param and `If-Modified-Since` header.
 * Returns 304 Not Modified if data hasn't changed since the client's timestamp.
 * Sets `Last-Modified` header on responses for client caching.
 *
 * Source of truth is the `flowsheet_watermark.last_modified_at` single-row
 * sibling table (BS#902 / Epic F F1). The prior process-local watermark
 * broke as soon as more than one BS pod sat behind the load balancer —
 * each pod kept its own value, so iOS polls fanned across pods would
 * either 304 against the wrong baseline or 200-with-redundant-data on pod
 * swap. Migration 0084 wires an AFTER INSERT/UPDATE/DELETE STATEMENT
 * trigger on `flowsheet` that touches this row, so the watermark advances
 * on every mutation (including deletes — which a `MAX(flowsheet.updated_at)`
 * read would have missed). PK lookup is O(1).
 */
export const conditionalGet: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const lastModified = await flowsheet_service.getLastModifiedAt();

  // Check query param first, then header
  const sinceParam = req.query.since as string | undefined;
  const sinceHeader = req.get('If-Modified-Since');
  const sinceStr = sinceParam || sinceHeader;

  if (sinceStr) {
    const clientTime = new Date(sinceStr);
    // HTTP Date format only has second precision, so compare at second
    // granularity. The DB trigger gives ms precision; both sides floor to
    // whole seconds before the inequality so a write within the same wall-
    // clock second as the client's last poll still produces a 304.
    const clientSeconds = Math.floor(clientTime.getTime() / 1000);
    const serverSeconds = Math.floor(lastModified.getTime() / 1000);
    if (!isNaN(clientSeconds) && clientSeconds >= serverSeconds) {
      res.status(304).end();
      return;
    }
  }

  // Set Last-Modified header for client to use in future requests
  res.set('Last-Modified', lastModified.toUTCString());
  next();
};
