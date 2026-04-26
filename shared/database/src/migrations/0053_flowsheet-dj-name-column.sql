-- Add the dj_name column on flowsheet (step 5b.1).
--
-- The original version of this migration mixed this DDL with a 2.6M-row
-- backfill UPDATE in a single transaction. ALTER TABLE acquires an
-- AccessExclusiveLock that is held until the transaction commits, and the
-- backfill UPDATE took longer than the deploy step's SSH timeout. The
-- container was killed but the orphaned PostgreSQL backend kept holding the
-- lock, wedging every subsequent read of flowsheet for ~13 hours and
-- blocking every retry of the migration. See issue #511.
--
-- The backfill now lives in jobs/backfills/flowsheet-dj-name-backfill and
-- runs as a one-shot deploy after this DDL ships. Migration 0054 has a
-- precondition guard that fails fast if any track row still has dj_name IS
-- NULL, so deploys can't accidentally race ahead of the backfill.
--
-- Order of operations across the 5b sub-issues:
--   5b.1  (this migration):   add the column nullable.
--   5b.1b (backfill job):     populate legacy rows in batched UPDATEs.
--   5b.2  (etl + controller): write the column on every new insert.
--   5b.3  (migration 0054):   switch search reads to flowsheet.dj_name.
--
-- Production note: ALTER TABLE ADD COLUMN of a nullable column is
-- metadata-only and instant, regardless of table size.

ALTER TABLE "wxyc_schema"."flowsheet"
  ADD COLUMN "dj_name" text;
