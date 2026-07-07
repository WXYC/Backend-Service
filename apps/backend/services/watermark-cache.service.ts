/**
 * A per-watermark in-process cache (BS#1468). Pairs a watermark provider with a
 * builder; `get()` returns the cached payload while the watermark is unchanged
 * and rebuilds exactly once when it advances. Table-agnostic so it can back any
 * "build once per freshness value" surface.
 *
 * Requires the watermark provider to be **monotonic non-decreasing** — the
 * catalog provider reads `library_watermark`, advanced by
 * `GREATEST(now(), last_modified_at)` (migration 0104), which never retreats.
 * The cached entry is only replaced by a build for an equal-or-newer watermark,
 * so a slow build for an older watermark that resolves late cannot clobber a
 * fresher cached payload. A provider that can move backward would break that
 * guard and must not be used here.
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
        // Publish only if no equal-or-newer watermark has already been cached.
        // Builds for different watermarks can overlap (the watermark advanced
        // mid-build); a slower OLDER build resolving last must not clobber the
        // fresher entry. Safe because the provider is monotonic (see type doc).
        if (!cached || watermark >= cached.watermark) {
          cached = { watermark, payload };
        }
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
