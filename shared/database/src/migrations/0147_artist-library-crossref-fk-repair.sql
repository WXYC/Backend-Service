-- precondition-guard: not-required (this migration does not touch library_identity / library_identity_source / library_identity_history; it repairs a foreign key on artist_library_crossreference, which is outside the cross-cache-identity substrate)
-- BS#2112. Repair the drifted ON DELETE action on
-- `wxyc_schema.artist_library_crossreference.library_id`.
--
-- `shared/database/src/schema.ts` has declared this FK
-- `.references(() => library.id, { onDelete: 'cascade' })` since it was
-- written, and every meta snapshot from 0022 forward records it as
-- `"onDelete": "cascade"`. The live constraint does not agree: migration
-- 0022 created it `ON DELETE no action` and no later migration changed it.
--
-- The drift is invisible to drizzle-kit and self-perpetuating. `generate`
-- diffs schema.ts against the last SNAPSHOT, never against the database, and
-- the snapshot already says cascade — so drizzle-kit sees no delta and will
-- never emit a corrective diff on its own. The only way to reconcile the two
-- is a hand-written DDL migration like this one (`--custom`, so the journal
-- entry and snapshot are still drizzle-authored).
--
-- Discovered by BS#2112's integration suite: `DELETE /library/:id` raised a
-- raw FK violation on a release carrying a crossreference row, against a
-- schema that says the row should have cascaded. `deleteAlbumFromDB` deletes
-- the crossreference rows explicitly and keeps doing so after this migration
-- — belt and braces, and it keeps the endpoint correct on any environment
-- that hasn't applied this yet.
--
-- SCOPE: `library_id` only. The sibling `artist_id` FK on the same table has
-- exactly the same 0022 drift (declared cascade, created `no action`), but
-- repairing it would change what happens when an ARTIST row is deleted — a
-- different blast radius, no caller asking for it, and `jobs/artist-unicode-
-- dedup` (the one job that deletes artists) repoints every FK by hand before
-- deleting and so does not depend on either behavior. Left alone deliberately;
-- if it is ever repaired it should be its own migration with its own test.
--
-- Lock behavior: ALTER TABLE takes an AccessExclusiveLock on
-- artist_library_crossreference (~132k rows) and a ShareRowExclusiveLock on
-- `library` for the new constraint's validation scan. Both are bounded by the
-- lock_timeout below. Re-adding the FK re-validates every row, which is a
-- full scan of the crossreference table plus an index probe per row into
-- library's PK — seconds, not minutes, at this table size.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- Precondition guard (issue #705), in its own block so it runs — and can
-- fail the migration with a readable message — before any DDL is attempted.
--
-- Two preconditions. (a) The constraint must exist under the name 0022 gave
-- it; if it doesn't, this migration's assumptions about the substrate are
-- wrong and re-adding blindly would paper over that. (b) No orphan rows, the
-- FK-shaped precondition the rule asks for — re-adding the constraint
-- re-validates every row, so an orphan would abort mid-ALTER with an opaque
-- foreign_key_violation. (b) is near-provably zero here: `ON DELETE no
-- action` still ENFORCES referential integrity, it only declines to
-- propagate, so an orphan requires the constraint to have been added NOT
-- VALID or rows loaded with triggers disabled. Counted anyway, because
-- "cannot happen" is exactly the assumption that wedges a deploy.
DO $$
DECLARE
  current_action "char";
  orphan_count bigint;
BEGIN
  SELECT confdeltype INTO current_action
    FROM pg_constraint
   WHERE conname = 'artist_library_crossreference_library_id_library_id_fk'
     AND conrelid = to_regclass('wxyc_schema.artist_library_crossreference');

  IF current_action IS NULL THEN
    RAISE EXCEPTION 'Cannot repair artist_library_crossreference_library_id_library_id_fk: the constraint does not exist on wxyc_schema.artist_library_crossreference. This migration assumes migration 0022 applied; investigate before retrying.';
  END IF;

  SELECT COUNT(*) INTO orphan_count
    FROM wxyc_schema.artist_library_crossreference x
    LEFT JOIN wxyc_schema.library l ON l.id = x.library_id
   WHERE l.id IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'Cannot repair artist_library_crossreference_library_id_library_id_fk: % crossreference row(s) reference a library id that does not exist. Clean the orphans first; re-adding the FK would fail validation.', orphan_count;
  END IF;
END $$;
--> statement-breakpoint

-- Apply. Conditional on the CURRENT action rather than unconditional, so the
-- migration is a no-op wherever the constraint already carries the declared
-- cascade (a manual repair that beat the deploy, or a future fresh-database
-- path that stops inheriting 0022's `no action`) instead of taking an
-- AccessExclusiveLock and re-validating 132k rows for nothing.
DO $$
DECLARE
  current_action "char";
BEGIN
  SELECT confdeltype INTO current_action
    FROM pg_constraint
   WHERE conname = 'artist_library_crossreference_library_id_library_id_fk'
     AND conrelid = to_regclass('wxyc_schema.artist_library_crossreference');

  IF current_action = 'c' THEN
    RAISE NOTICE 'artist_library_crossreference_library_id_library_id_fk is already ON DELETE CASCADE; nothing to repair.';
    RETURN;
  END IF;

  ALTER TABLE "wxyc_schema"."artist_library_crossreference"
    DROP CONSTRAINT "artist_library_crossreference_library_id_library_id_fk";

  ALTER TABLE "wxyc_schema"."artist_library_crossreference"
    ADD CONSTRAINT "artist_library_crossreference_library_id_library_id_fk"
    FOREIGN KEY ("library_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
END $$;
