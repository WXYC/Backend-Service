-- BS#2318 — attach the `library_watermark` trigger to `digital_asset`, and
-- add a callable wrapper so application code can advance the watermark
-- directly.
--
-- Reuses `wxyc_schema.touch_library_watermark()` VERBATIM (defined in 0104,
-- narrowed on `library` by 0142) — same single-row `library_watermark`
-- UPDATE, same monotonic `GREATEST(now(), last_modified_at)` advance, same
-- O(1) per-statement cost. Do NOT redefine the function here. This migration
-- creates no Drizzle-modeled schema object, so `drizzle:generate` produces no
-- diff and this is a `--custom` migration whose snapshot is byte-identical to
-- 0158's (0142's precedent for a trigger-only migration).
--
-- COLUMN NARROWING — mirrors 0142's narrowing of the `library` trigger.
-- `UPDATE OF status, library_id` rather than an unqualified `UPDATE`: those
-- are the two `digital_asset` columns that can change whether a row is
-- export-eligible — `status` (a row becoming servable) and `library_id`
-- (which album it is bound to). Every other column (the rip-evidence fields,
-- `bind_note`, etc.) is descriptive and does not affect
-- `has_digital_audio`, so an update touching only those must not advance a
-- watermark that would invalidate every client's cached catalog. INSERT /
-- DELETE / TRUNCATE stay unqualified — Postgres does not support an `OF
-- <columns>` qualifier on those event types, and a deleted or truncated row
-- can retreat what a naive read would show, so all of them must advance the
-- watermark unconditionally (0104's reasoning, unchanged here). `TRUNCATE`
-- is deliberately kept in the event list, per 0142.
--
-- Idempotent: `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER` (`CREATE
-- TRIGGER` itself is not idempotent) so a re-apply is a no-op followed by the
-- trigger landing cleanly.
--
-- CALLABLE WRAPPER — `touch_library_watermark()` is `RETURNS trigger` and
-- cannot be invoked from application code (a trigger function can only run
-- as a trigger). `touch_library_watermark_now()` reproduces 0104's UPDATE
-- statement EXACTLY: `GREATEST`, not a bare `now()` — 0104's header records
-- that `now()` is `transaction_timestamp()`, frozen at transaction start, and
-- that the formula must be monotonic so the watermark can never retreat on
-- clock skew. A bare `now()` would also let a backward wall-clock correction
-- move the watermark DOWN — the drift half of the #1106 failure mode 0104
-- was written to close. The column is `last_modified_at`, not `updated_at`.
-- `WHERE id = true` matches `library_watermark`'s singleton CHECK
-- (`library_watermark_singleton`) and keeps the wrapper correct if a second
-- row ever becomes representable. Consumed by WXYC/Backend-Service#2320's
-- startup hook (via `SELECT wxyc_schema.touch_library_watermark_now()`) when
-- it detects a `catalog_export_flag_state` value flip.
--
-- @no-precondition-needed: trigger + function DDL only; no constraint, no
-- data invariant, no existing rows to violate.
-- @no-analyze-needed: no UPDATE runs at migration-apply time — the wrapper's
-- UPDATE only executes when application code later calls the function, and
-- even then it rewrites the single-row `library_watermark` table (no
-- planner-stats surface area to drift, per 0104's header).

DROP TRIGGER IF EXISTS touch_library_watermark ON wxyc_schema.digital_asset;--> statement-breakpoint
CREATE TRIGGER touch_library_watermark
AFTER INSERT OR UPDATE OF status, library_id OR DELETE OR TRUNCATE ON wxyc_schema.digital_asset
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_library_watermark();--> statement-breakpoint
CREATE OR REPLACE FUNCTION wxyc_schema.touch_library_watermark_now() RETURNS void AS $$
  UPDATE wxyc_schema.library_watermark
  SET last_modified_at = GREATEST(now(), last_modified_at)
  WHERE id = true;
$$ LANGUAGE sql;
