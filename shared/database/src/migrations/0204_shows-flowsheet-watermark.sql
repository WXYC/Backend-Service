-- BS#3456 — advance the flowsheet conditional-GET watermark on `shows` updates.
--
-- `PATCH /flowsheet/shows/{id}` retags or retitles a show without writing a flowsheet row, and `GET /flowsheet`
-- embeds the open show's id, title and specialty in `on_air`. The 0084 watermark (`flowsheet_watermark`, read by
-- `apps/backend/middleware/conditionalGet.ts`) moved only on `flowsheet` writes, so a tag change sat behind a stale
-- 304 until the next row. A statement-level trigger lands in the same transaction as the change and cannot be
-- forgotten by a new code path.
--
-- Cost, accepted: a sign-off's `end_time` update bumps the watermark a second time beside the bump its `show_end` row
-- already causes, and a statement-level trigger fires even when its UPDATE matches no row, so nearly every Go Live
-- bumps it once more through `closeShowFromTerminalShowEndMarker`'s usually-empty UPDATE. Polling clients absorb each
-- as one more full fetch.
--
-- Reuses `wxyc_schema.touch_flowsheet_watermark()` VERBATIM (defined in migration 0084), as 0114 does for `concerts`.
-- Do NOT redefine the function here. No schema objects change, so the 0204 snapshot is byte-identical to 0203's apart
-- from the id/prevId chain link.
--
-- Idempotent: `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER` so a re-apply is a no-op.
--
-- @no-analyze-needed: no UPDATE on a stats-bearing table — the only write is the one-row `flowsheet_watermark` UPDATE
-- inside the reused trigger function.
-- @no-precondition-needed: trigger DDL only; no constraint, no data invariant.

DROP TRIGGER IF EXISTS touch_flowsheet_watermark_from_shows ON wxyc_schema.shows;--> statement-breakpoint
CREATE TRIGGER touch_flowsheet_watermark_from_shows
AFTER UPDATE ON wxyc_schema.shows
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_flowsheet_watermark();
