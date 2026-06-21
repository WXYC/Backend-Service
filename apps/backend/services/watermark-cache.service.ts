/**
 * A per-watermark in-process cache (BS#1468). Pairs a watermark provider with a
 * builder; `get()` returns the cached payload while the watermark is unchanged
 * and rebuilds exactly once when it advances. Table-agnostic so it can back any
 * "build once per freshness value" surface.
 */
export type WatermarkCache<T> = {
  get: () => Promise<T>;
};

export const createWatermarkCache = <T>(
  getWatermark: () => Promise<Date>,
  build: () => Promise<T>
): WatermarkCache<T> => {
  let cached: { watermark: number; payload: T } | undefined;
  // In-flight build for `inFlight.watermark`, shared by all concurrent reads at
  // that watermark so a freshness advance can't trigger N parallel 5-join
  // scans + gzips (thundering herd). Cleared once the build settles.
  let inFlight: { watermark: number; promise: Promise<T> } | undefined;

  const get = async (): Promise<T> => {
    const watermark = (await getWatermark()).getTime();
    if (cached && cached.watermark === watermark) {
      return cached.payload;
    }
    if (inFlight && inFlight.watermark === watermark) {
      return inFlight.promise;
    }

    const promise = build().then(
      (payload) => {
        cached = { watermark, payload };
        if (inFlight && inFlight.watermark === watermark) inFlight = undefined;
        return payload;
      },
      (err) => {
        // Let the next caller retry rather than caching a rejection.
        if (inFlight && inFlight.watermark === watermark) inFlight = undefined;
        throw err;
      }
    );
    inFlight = { watermark, promise };
    return promise;
  };

  return { get };
};
