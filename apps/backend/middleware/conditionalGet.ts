import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Provider of a resource's freshness watermark: the instant the underlying
 * collection was last mutated. Returns a `Date` (never null — providers seed a
 * defensive epoch fallback) so the middleware always has a comparable value.
 */
export type WatermarkProvider = () => Promise<Date>;

/**
 * Factory for conditional-GET middleware over a watermark provider.
 *
 * Supports both the `since` query param and the `If-Modified-Since` header.
 * Returns 304 Not Modified when the resource hasn't changed since the client's
 * timestamp, and sets `Last-Modified` on pass-through responses for client
 * caching.
 *
 * The watermark is injected rather than hardcoded so one middleware serves
 * every conditional-GET surface. Flowsheet (BS#902 / Epic F F1) passes
 * `flowsheet_service.getLastModifiedAt` (reads `flowsheet_watermark`); the
 * catalog (BS#1467) passes `library_service.getCatalogLastModifiedAt` (reads
 * `library_watermark`). Both are single-row sibling tables touched by an AFTER
 * INSERT/UPDATE/DELETE STATEMENT trigger so the watermark advances on every
 * mutation — including deletes and writes that bypass the BS app layer (the
 * library ETL writes straight to Postgres), which a `MAX(updated_at)` read
 * would have missed. PK lookup is O(1).
 *
 * The two triggers diverge in how they advance the watermark: flowsheet floors
 * each bump by `+1 second` (a high-frequency, human-paced writer with ~1 Hz
 * pollers, so it needs same-second disambiguation); the library trigger uses a
 * plain `GREATEST(now(), last_modified_at)` so a bulk single-transaction ETL
 * write — where `now()` is frozen at transaction start — can't drift the
 * watermark into the future. The second-flooring below is unrelated: it exists
 * purely because the HTTP `Date` header carries whole-second precision, and
 * applies to both providers.
 */
export const conditionalGet =
  (getWatermark: WatermarkProvider): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const lastModified = await getWatermark();

    // Check query param first, then header
    const sinceParam = req.query.since as string | undefined;
    const sinceHeader = req.get('If-Modified-Since');
    const sinceStr = sinceParam || sinceHeader;

    if (sinceStr) {
      const clientTime = new Date(sinceStr);
      // HTTP Date format only has second precision, so compare at second
      // granularity. (Flowsheet's trigger also floors progress by a whole
      // second; the library trigger does not — but that's invisible here,
      // because the flooring below is about the HTTP `Date` header's
      // precision, not the trigger formula. A within-second watermark bump
      // must not trip a redundant 200.)
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
