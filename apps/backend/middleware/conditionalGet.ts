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
/**
 * Sentinel written to the `ETag` header before the route handler runs, so
 * that Express's own per-body ETag generation never fires (see below), then
 * stripped again right before the response is flushed.
 */
const ETAG_SUPPRESSED = 'wxyc-no-etag';

/**
 * Forces `conditionalGet`'s watermark `Last-Modified` to be the SINGLE
 * freshness validator on a route, by suppressing Express's default per-body
 * weak `ETag` and marking the response `Cache-Control: no-cache` (BS#1689).
 *
 * Without this, a watermarked route emits two independent validators: the
 * `Last-Modified` this middleware's sibling `conditionalGet` sets, and
 * Express's own body-hash `ETag`. Express computes that `ETag` and evaluates
 * `req.fresh` (comparing it and `Last-Modified` against the request's
 * `If-None-Match`/`If-Modified-Since`) *inside* `res.send`, independently of
 * — and racing — `conditionalGet`'s own explicit watermark check upstream.
 * A client whose cached `ETag` happens to match can trip Express's internal
 * freshness conversion to a raw 304 that never went through
 * `conditionalGet`'s decision at all, which is how an unspliced empty-body
 * 304 reached the dj-site frontend (dj-site#983 / dj-site#982).
 *
 * Mechanism: `res.send`'s own check is `!this.get('ETag') && typeof etagFn
 * === 'function'` — pre-setting a sentinel `ETag` here makes that check false,
 * so Express never computes (or compares against) a real per-body hash. The
 * sentinel must then be removed from the actual response: overriding
 * `res.end` (rather than `res.send`/`res.json`) is necessary because Express
 * sets the `ETag` header synchronously *inside* `send`, before it calls
 * `this.end(...)` at the very end of that same function — stripping the
 * header from within our wrapped `end` runs after Express is done with it but
 * before Node flushes headers to the socket.
 *
 * Must run before the route handler.
 */
export const singleValidatorCache: RequestHandler = (_req, res, next) => {
  res.set('ETag', ETAG_SUPPRESSED);
  res.set('Cache-Control', 'no-cache');

  const originalEnd = res.end.bind(res);
  res.end = ((...args: Parameters<typeof originalEnd>) => {
    res.removeHeader('ETag');
    return originalEnd(...args);
  }) as typeof res.end;

  next();
};

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
