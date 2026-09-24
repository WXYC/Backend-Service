-- Custom SQL migration file, put your code below! --

-- BS#2004: pin the truth about `library.album_artist` where the next reader
-- will find it. The column has been NULL on every row since migration 0040
-- created it (2026-04-20): the tubafrenzy source column it mirrored was never
-- populated — 0 non-NULL against the frozen legacy MySQL, confirmed by the
-- catalog parity harness on 2026-09-16 — so the ETL only ever mirrored NULL and
-- no other writer existed. It gains a write path on POST/PATCH /library in the
-- same change as this migration, and is retained deliberately for a future
-- backfill from the Discogs release pins (lml_cache.library_release_override).
--
-- DDL-only, no ALTER TABLE. `COMMENT ON COLUMN` is idempotent (last write
-- wins), so no guard is needed. `library` lives in `wxyc_schema`, not `public`.
COMMENT ON COLUMN "wxyc_schema"."library"."album_artist" IS 'Credited album artist on a compilation card (e.g. "Kruder & Dorfmeister" on a DJ-Kicks release filed under Various Artists). NULL on every row as of 2026-09: the legacy tubafrenzy column was never populated, so the ETL only ever mirrored NULL. Writable via POST/PATCH /library since BS#2004; retained for a future backfill from the Discogs release pins. Do not gate behaviour on it — use the V/A code-letters rule for "is this a compilation".';
