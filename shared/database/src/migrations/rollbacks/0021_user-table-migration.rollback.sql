-- Rollback: 0021_user-table-migration
-- Original migration: 0021_user-table-migration.sql
-- Risk level: HIGH
-- Data loss: YES (dj_stats data will be lost, FK references to auth_user broken)
-- Generated: 2026-02-02
--
-- IMPORTANT: This rollback CANNOT fully restore the original state because:
-- 1. The original djs table was dropped with CASCADE
-- 2. Foreign key relationships were changed from djs.id (integer) to auth_user.id (varchar)
-- 3. A complete rollback requires restoring from a pre-migration backup
--
-- This rollback will:
-- - Drop the new dj_stats table
-- - Remove FK constraints pointing to auth_user
-- - Attempt to revert column types (may fail if data exists)
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application stopped (required for this rollback)
-- [ ] Maintenance window scheduled
-- [ ] Plan for data restoration from backup

-- BEGIN ROLLBACK

-- WARNING: This is a PARTIAL rollback. Full restoration requires backup.

-- Step 1: Drop foreign key constraints to auth_user
ALTER TABLE "wxyc_schema"."dj_stats" DROP CONSTRAINT IF EXISTS "dj_stats_user_id_auth_user_id_fk";
ALTER TABLE "wxyc_schema"."bins" DROP CONSTRAINT IF EXISTS "bins_dj_id_auth_user_id_fk";
ALTER TABLE "wxyc_schema"."schedule" DROP CONSTRAINT IF EXISTS "schedule_assigned_dj_id_auth_user_id_fk";
ALTER TABLE "wxyc_schema"."schedule" DROP CONSTRAINT IF EXISTS "schedule_assigned_dj_id2_auth_user_id_fk";
ALTER TABLE "wxyc_schema"."shift_covers" DROP CONSTRAINT IF EXISTS "shift_covers_cover_dj_id_auth_user_id_fk";
ALTER TABLE "wxyc_schema"."show_djs" DROP CONSTRAINT IF EXISTS "show_djs_dj_id_auth_user_id_fk";
ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT IF EXISTS "shows_primary_dj_id_auth_user_id_fk";

-- Step 2: Drop the new dj_stats table
DROP TABLE IF EXISTS "wxyc_schema"."dj_stats";

-- Step 3: NOTE - Cannot automatically revert column types from varchar(255) back to integer
-- The original djs table no longer exists, so we cannot restore the FK relationships.
-- Manual intervention required:
-- 1. Restore djs table from backup
-- 2. Restore FK relationships manually
-- 3. Convert dj_id columns back to integer type if needed

-- The following commands are commented out because they will likely fail
-- without first restoring the djs table and mapping user IDs:
--
-- ALTER TABLE "wxyc_schema"."bins" ALTER COLUMN "dj_id" SET DATA TYPE integer USING dj_id::integer;
-- ALTER TABLE "wxyc_schema"."schedule" ALTER COLUMN "assigned_dj_id" SET DATA TYPE integer;
-- ALTER TABLE "wxyc_schema"."schedule" ALTER COLUMN "assigned_dj_id2" SET DATA TYPE integer;
-- ALTER TABLE "wxyc_schema"."shift_covers" ALTER COLUMN "cover_dj_id" SET DATA TYPE integer;
-- ALTER TABLE "wxyc_schema"."show_djs" ALTER COLUMN "dj_id" SET DATA TYPE integer;
-- ALTER TABLE "wxyc_schema"."shows" ALTER COLUMN "primary_dj_id" SET DATA TYPE integer;

-- END ROLLBACK

-- NEXT STEPS AFTER RUNNING THIS ROLLBACK:
-- 1. Restore the djs table from backup:
--    pg_restore -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -t djs backup.dump
-- 2. Restore any other dependent data
-- 3. Re-add foreign key constraints to djs table
