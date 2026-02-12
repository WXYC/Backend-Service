-- Rollback: 0014_zippy_secret_warriors
-- Original migration: 0014_zippy_secret_warriors.sql
-- Risk level: HIGH
-- Data loss: YES
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the changes made by 0014_zippy_secret_warriors.sql
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed
-- [ ] Maintenance window scheduled

-- Operations:
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Requires manual data restoration from backup
-- - Requires manual data restoration from backup
-- - Requires manual data restoration from backup

-- BEGIN ROLLBACK

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Requires manual data restoration from backup
-- WARNING: Original migration dropped data that cannot be restored
-- Original: ALTER TABLE "wxyc_schema"."shows" DROP COLUMN IF EXISTS "dj_id";...

-- Requires manual data restoration from backup
-- WARNING: Original migration dropped data that cannot be restored
-- Original: ALTER TABLE "wxyc_schema"."shows" DROP COLUMN IF EXISTS "dj_id2";...

-- Requires manual data restoration from backup
-- WARNING: Original migration dropped data that cannot be restored
-- Original: ALTER TABLE "wxyc_schema"."shows" DROP COLUMN IF EXISTS "dj_id3";...

-- END ROLLBACK
