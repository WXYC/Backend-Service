-- precondition-guard: not-required (DROP + ADD CONSTRAINT on existing FKs is a
--   pure constraint-shape change; no data invariant is asserted by the new
--   ON DELETE actions and no rows can violate the redefined FK as long as the
--   referenced parent rows still exist — which they already do because the
--   old NO ACTION constraint enforced exactly that)
-- @no-precondition-needed: ON DELETE behaviour change is forward-looking; it
--   governs future DELETEs on the parent table, not the present FK shape.
-- 0097 — Fix FK ON DELETE drift on flowsheet / rotation / reviews.
--
-- Five FK constraints were created with ON DELETE NO ACTION in
-- `0000_rare_prima.sql` and recreated unchanged by `0016_nervous_hydra.sql`,
-- but the Drizzle schema source declares them as SET NULL (flowsheet) and
-- CASCADE (rotation, reviews). The most-recent snapshot
-- (`meta/0096_snapshot.json`) records the schema-source values, masking the
-- drift from `drizzle-kit generate` — no subsequent migration patched the
-- production DB to match, so new environments diverge from prod.
--
-- This migration follows the pattern in `0048_fix-fk-on-delete-set-null.sql`
-- (the predecessor that patched the analogous drift for schedule /
-- shift_covers / shows.primary_dj_id; see #433) but uses `ADD CONSTRAINT
-- ... NOT VALID` rather than a bare `ADD CONSTRAINT` to avoid blocking
-- writes on flowsheet (~857k prod rows) during the deploy. The five
-- constraints below were missed by 0048.
--
-- ## Lock behaviour: why NOT VALID (and why VALIDATE runs out-of-band)
--
-- A bare `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ...` takes an
-- `AccessExclusiveLock` AND runs a full-table validation scan that holds
-- the lock for the entire scan — blocking every concurrent INSERT/UPDATE/
-- DELETE on the table for the deploy's duration. On an on-air station with
-- active DJs writing flowsheet rows in real time, that is a user-visible
-- outage window.
--
-- `ADD CONSTRAINT ... NOT VALID` skips the validation scan: it takes
-- `AccessExclusiveLock` for a metadata-only change and releases it
-- instantly. New writes are enforced against the new FK shape immediately;
-- only retroactive validation of pre-existing rows is deferred.
--
-- The companion `ALTER TABLE ... VALIDATE CONSTRAINT` runs the scan under
-- the lighter `ShareUpdateExclusiveLock`, which allows concurrent SELECT,
-- INSERT, UPDATE, DELETE. **But this benefit only materializes if VALIDATE
-- runs in its OWN transaction** — Drizzle's migrator
-- (`drizzle-orm/pg-core/dialect.js:60`) wraps the entire migration in one
-- `session.transaction()`, so a VALIDATE statement inside the migration
-- file would run under the AccessExclusiveLock that the preceding DROP /
-- ADD already acquired, defeating the point. We therefore omit VALIDATE
-- here and document it as the post-deploy operator step below.
--
-- For these five constraints the validation is effectively a no-op anyway:
-- the existing `NO ACTION` FK has already kept the reference relation
-- consistent (every flowsheet.album_id either points at a live library.id
-- or is NULL). Changing only the `ON DELETE` action does not introduce
-- any new data invariant on existing rows — the action governs future
-- parent-row DELETEs. VALIDATE still has to scan because PostgreSQL
-- tracks the `convalidated` flag per constraint; until VALIDATE runs the
-- constraint is recorded as "trusted for new writes but not proven for
-- old rows."
--
-- ## Post-deploy operator step
--
-- After this migration deploys, an operator runs the following five
-- statements (each in its own implicit transaction — do NOT wrap them in
-- BEGIN/COMMIT) during a low-write window to clear the unvalidated state.
-- Skipping this step is harmless for correctness; it only leaves the
-- constraints with `convalidated = false` until the next operator runs
-- it. A bare `ANALYZE` is not needed (no row mutations).
--
--   ALTER TABLE "wxyc_schema"."flowsheet" VALIDATE CONSTRAINT "flowsheet_show_id_shows_id_fk";
--   ALTER TABLE "wxyc_schema"."flowsheet" VALIDATE CONSTRAINT "flowsheet_album_id_library_id_fk";
--   ALTER TABLE "wxyc_schema"."flowsheet" VALIDATE CONSTRAINT "flowsheet_rotation_id_rotation_id_fk";
--   ALTER TABLE "wxyc_schema"."rotation"  VALIDATE CONSTRAINT "rotation_album_id_library_id_fk";
--   ALTER TABLE "wxyc_schema"."reviews"   VALIDATE CONSTRAINT "reviews_album_id_library_id_fk";
--
-- We DROP+ADD rather than `ALTER CONSTRAINT` because PostgreSQL has no
-- syntax to change `ON DELETE` action in place — you must drop and recreate.
-- The DROP itself is metadata-only and instant.
--
-- See WXYC/Backend-Service#1126 for the full drift table and reproduction.
-- See PostgreSQL docs:
--   https://www.postgresql.org/docs/current/sql-altertable.html (NOT VALID)
--   https://www.postgresql.org/docs/current/explicit-locking.html (lock modes)

-- flowsheet.show_id → shows.id : NO ACTION → SET NULL
ALTER TABLE "wxyc_schema"."flowsheet" DROP CONSTRAINT "flowsheet_show_id_shows_id_fk";
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "wxyc_schema"."shows"("id") ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;

-- flowsheet.album_id → library.id : NO ACTION → SET NULL
ALTER TABLE "wxyc_schema"."flowsheet" DROP CONSTRAINT "flowsheet_album_id_library_id_fk";
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;

-- flowsheet.rotation_id → rotation.id : NO ACTION → SET NULL
ALTER TABLE "wxyc_schema"."flowsheet" DROP CONSTRAINT "flowsheet_rotation_id_rotation_id_fk";
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_rotation_id_rotation_id_fk" FOREIGN KEY ("rotation_id") REFERENCES "wxyc_schema"."rotation"("id") ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;

-- rotation.album_id → library.id : NO ACTION → CASCADE
ALTER TABLE "wxyc_schema"."rotation" DROP CONSTRAINT "rotation_album_id_library_id_fk";
ALTER TABLE "wxyc_schema"."rotation" ADD CONSTRAINT "rotation_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;

-- reviews.album_id → library.id : NO ACTION → CASCADE
ALTER TABLE "wxyc_schema"."reviews" DROP CONSTRAINT "reviews_album_id_library_id_fk";
ALTER TABLE "wxyc_schema"."reviews" ADD CONSTRAINT "reviews_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
