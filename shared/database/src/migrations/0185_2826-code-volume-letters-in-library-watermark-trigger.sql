-- BS#2826: add `code_volume_letters` to the `UPDATE OF` column list of the `touch_library_watermark` trigger on `wxyc_schema.library`.
--
-- GET /library/catalog now exports `CatalogExportRow.code_volume_letters`. Migration 0142's OBLIGATION block requires every column added to `CatalogExportRow` to be added to that trigger's `UPDATE OF` list in the same PR. Without it, a PATCH or backfill that sets only `code_volume_letters` never advances `library_watermark`, and the conditional GET keeps serving the stale cached body or a 304, so production library.db (which is built only from this export) never sees the letter.
--
-- The list below is 0142's 14 columns carried forward unchanged and in order, plus `code_volume_letters` (no later migration redefined this trigger: 0143 and 0159 touch other tables). INSERT / DELETE / TRUNCATE stay unqualified, as in 0142. The function `wxyc_schema.touch_library_watermark()` is reused verbatim and not redefined.
--
-- Trigger DDL only: no schema objects change, so the snapshot is 0184's with a new id/prevId chain link (same precedent as 0142). Idempotent via `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`. Takes a brief ACCESS EXCLUSIVE-class lock on `wxyc_schema.library` for the DROP/CREATE inside the migration transaction; no rows are read or written.
--
-- @no-analyze-needed: no UPDATE on a stats-bearing table.
-- @no-precondition-needed: trigger DDL only; no constraint, no data invariant.

DROP TRIGGER IF EXISTS touch_library_watermark ON wxyc_schema.library;--> statement-breakpoint
CREATE TRIGGER touch_library_watermark
AFTER INSERT OR UPDATE OF
  id,
  legacy_release_id,
  artist_id,
  genre_id,
  format_id,
  alternate_artist_name,
  album_artist,
  album_title,
  label,
  code_number,
  code_volume_letters,
  on_streaming,
  artwork_url,
  artist_name,
  canonical_entity_id
  OR DELETE OR TRUNCATE ON wxyc_schema.library
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_library_watermark();
