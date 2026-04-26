-- Add a partial functional index to make the playlist-proxy artwork lookup
-- an index scan instead of a 2.6M-row sequential scan.
--
-- The query in `apps/backend/services/playlist-proxy.service.ts` runs every
-- time tubafrenzy emits a `created`/`updated` SSE event. It computes a
-- lookup key on the fly:
--
--   lower(trim(artist_name)) || '-' || lower(trim(coalesce(album_title, '')))
--
-- and asks "has any prior flowsheet row already cached `artwork_url` for
-- this same artist+album combo?". Without an index, every event scans the
-- whole flowsheet table — and on a hot table that's 7-15 minutes per scan.
-- During incident #511 those scans accumulated as orphans (the calling
-- backend HTTP request had timed out long before the scan finished),
-- holding AccessShareLock and blocking DDL.
--
-- The functional index makes the SQL plan:
--   Index Scan using flowsheet_artwork_lookup_idx (cost: ms, not minutes)
--
-- Partial because only ~5-10% of rows have non-null `artwork_url`. The
-- query selects `artwork_url` and filters by the lookup key — every other
-- row would be index dead weight. With the partial predicate the index is
-- ~10-20MB instead of ~250MB on disk.
--
-- Production note: this is a regular CREATE INDEX (not CONCURRENTLY)
-- because the partial predicate keeps the build small (~200K matching
-- rows). Build time is seconds. CREATE INDEX takes a `ShareLock` on the
-- table that briefly blocks writes — INSERTs from the live path queue up
-- for a few seconds. INSERT throughput is well under the rate that a
-- few-second pause would cause user-visible problems.
--
-- The index is not used by any existing query plan, so it cannot regress
-- any path. It is consulted only when the playlist-proxy's lookup key
-- expression appears in a `WHERE` clause — i.e. exclusively the queries
-- in `playlist-proxy.service.ts:enrichPlaycuts` and `enrichSinglePlaycut`.

CREATE INDEX "flowsheet_artwork_lookup_idx"
  ON "wxyc_schema"."flowsheet"
  ((lower(trim("artist_name")) || '-' || lower(trim(coalesce("album_title", '')))))
  WHERE "artwork_url" IS NOT NULL;
