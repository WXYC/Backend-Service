-- Rollback: 0010_polite_black_tarantula
-- Original migration: 0010_polite_black_tarantula.sql
-- Risk level: LOW
-- Data loss: NO
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the changes made by 0010_polite_black_tarantula.sql
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed

-- Operations:
-- - Requires manual data restoration from backup

-- BEGIN ROLLBACK

-- Requires manual data restoration from backup
-- WARNING: Original migration dropped data that cannot be restored
-- Original: ALTER TABLE "wxyc_schema"."djs" DROP COLUMN IF EXISTS "email";...

-- END ROLLBACK
