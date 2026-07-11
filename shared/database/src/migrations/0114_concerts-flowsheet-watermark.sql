-- BS#1607 — advance the flowsheet conditional-GET watermark on `concerts` writes.
--
-- The V2 flowsheet feed embeds a per-playcut `upcoming_show` (Concert) via
-- `attachUpcomingShows` (apps/backend/services/flowsheet.service.ts). That makes
-- the conditional-GET-cached `GET /flowsheet` and `GET /flowsheet/latest`
-- responses depend on the `concerts` table — not just on `flowsheet`. But the
-- 0084 watermark (`flowsheet_watermark`, read by
-- `apps/backend/middleware/conditionalGet.ts`) is only touched by a trigger on
-- `flowsheet`, so a concerts write left the watermark unmoved and clients kept
-- receiving 304s against a page whose CTA had changed:
--
--   stale-add: an overnight concerts ETL adds a date for an artist on the cached
--   page; the watermark doesn't move, so clients don't see the new CTA until the
--   next flowsheet write. THIS trigger fixes the stale-add case — a concerts
--   INSERT/UPDATE/DELETE now advances the watermark directly.
--
--   stale-drop: after ET midnight with no overnight flowsheet write, a CTA for a
--   now-past show keeps rendering (the feed filters `starts_on >= today ET`, but
--   nothing wrote a row). That half is a pure clock event no statement trigger
--   can observe; it is handled in `getLastModifiedAt`, which folds
--   `max(flowsheet_watermark, nyStartOfDay(now))` so the watermark jumps forward
--   at ET midnight. The two halves are complementary.
--
-- Reuses `wxyc_schema.touch_flowsheet_watermark()` VERBATIM (defined in migration
-- 0084) — same single-row `flowsheet_watermark` UPDATE, same monotonic
-- `GREATEST(now(), last_modified_at + interval '1 second')` advance, same O(1)
-- per-statement cost. Do NOT redefine the function here. No schema objects
-- change, so `drizzle:generate` produces no diff and the 0114 snapshot is
-- byte-identical to 0113's apart from the id/prevId chain link (a `--custom`
-- migration, mirroring 0105_library-watermark-parent-tables).
--
-- Idempotent: `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER` so a re-apply (or
-- a fresh dev DB that already picked it up) is a no-op.
--
-- @no-analyze-needed: no UPDATE on a stats-bearing table — the only write is the
-- one-row `flowsheet_watermark` UPDATE inside the reused trigger function.
-- @no-precondition-needed: trigger DDL only; no constraint, no data invariant.

DROP TRIGGER IF EXISTS touch_flowsheet_watermark_from_concerts ON wxyc_schema.concerts;--> statement-breakpoint
CREATE TRIGGER touch_flowsheet_watermark_from_concerts
AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.concerts
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_flowsheet_watermark();
