-- precondition-guard: not-required (DROP + ADD CONSTRAINT on existing FKs is a
--   pure constraint-shape change; no data invariant is asserted by the new
--   ON DELETE actions and no rows can violate the redefined FK as long as the
--   referenced parent rows still exist — which they already do because the
--   old NO ACTION constraint enforced exactly that)
-- @no-precondition-needed: ON DELETE behaviour change is forward-looking; it
--   governs future DELETEs on the parent table, not the present FK shape.
-- 0094 — Fix FK ON DELETE drift on flowsheet / rotation / reviews.
--
-- Five FK constraints were created with ON DELETE NO ACTION in
-- `0000_rare_prima.sql` and recreated unchanged by `0016_nervous_hydra.sql`,
-- but the Drizzle schema source declares them as SET NULL (flowsheet) and
-- CASCADE (rotation, reviews). The most-recent snapshot
-- (`meta/0093_snapshot.json`) records the schema-source values, masking the
-- drift from `drizzle-kit generate` — no subsequent migration patched the
-- production DB to match, so new environments diverge from prod.
--
-- This migration follows the pattern in `0048_fix-fk-on-delete-set-null.sql`
-- (the predecessor that patched the analogous drift for schedule /
-- shift_covers / shows.primary_dj_id; see #433). The five constraints below
-- were missed by 0048.
--
-- See WXYC/Backend-Service#1126 for the full drift table and reproduction.

-- flowsheet.show_id → shows.id : NO ACTION → SET NULL
ALTER TABLE "wxyc_schema"."flowsheet" DROP CONSTRAINT "flowsheet_show_id_shows_id_fk";
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "wxyc_schema"."shows"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- flowsheet.album_id → library.id : NO ACTION → SET NULL
ALTER TABLE "wxyc_schema"."flowsheet" DROP CONSTRAINT "flowsheet_album_id_library_id_fk";
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- flowsheet.rotation_id → rotation.id : NO ACTION → SET NULL
ALTER TABLE "wxyc_schema"."flowsheet" DROP CONSTRAINT "flowsheet_rotation_id_rotation_id_fk";
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_rotation_id_rotation_id_fk" FOREIGN KEY ("rotation_id") REFERENCES "wxyc_schema"."rotation"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- rotation.album_id → library.id : NO ACTION → CASCADE
ALTER TABLE "wxyc_schema"."rotation" DROP CONSTRAINT "rotation_album_id_library_id_fk";
ALTER TABLE "wxyc_schema"."rotation" ADD CONSTRAINT "rotation_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- reviews.album_id → library.id : NO ACTION → CASCADE
ALTER TABLE "wxyc_schema"."reviews" DROP CONSTRAINT "reviews_album_id_library_id_fk";
ALTER TABLE "wxyc_schema"."reviews" ADD CONSTRAINT "reviews_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
