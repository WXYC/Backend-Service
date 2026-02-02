-- Rollback: 0026_capabilities_column
-- Original migration: 0026_capabilities_column.sql
-- Risk level: HIGH
-- Data loss: YES
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the changes made by 0026_capabilities_column.sql
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed
-- [ ] Maintenance window scheduled

-- Operations:
-- - Drops column "capabilities" from "auth_user" (DATA LOSS)

-- BEGIN ROLLBACK

-- Drops column "capabilities" from "auth_user" (DATA LOSS)
ALTER TABLE "auth_user" DROP COLUMN IF EXISTS "capabilities";

-- END ROLLBACK
