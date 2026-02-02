-- Rollback: 0025_rate_limiting_tables
-- Original migration: 0025_rate_limiting_tables.sql
-- Risk level: HIGH
-- Data loss: YES
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the changes made by 0025_rate_limiting_tables.sql
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed
-- [ ] Maintenance window scheduled

-- Operations:
-- - Drops table "user_activity" (DATA LOSS)
-- - Drops column "is_anonymous" from "auth_user" (DATA LOSS)

-- BEGIN ROLLBACK

-- Drops table "user_activity" (DATA LOSS)
DROP TABLE IF EXISTS "user_activity" CASCADE;

-- Drops column "is_anonymous" from "auth_user" (DATA LOSS)
ALTER TABLE "auth_user" DROP COLUMN IF EXISTS "is_anonymous";

-- END ROLLBACK
