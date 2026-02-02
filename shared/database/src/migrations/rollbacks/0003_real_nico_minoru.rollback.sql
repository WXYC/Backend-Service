-- Rollback: 0003_real_nico_minoru
-- Original migration: 0003_real_nico_minoru.sql
-- Risk level: LOW
-- Data loss: NO
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the changes made by 0003_real_nico_minoru.sql
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed

-- Operations:
-- - Drops index "code_letters_idx"

-- BEGIN ROLLBACK

-- Drops index "code_letters_idx"
DROP INDEX IF EXISTS "code_letters_idx";

-- END ROLLBACK
