-- Rollback: 0007_happy_black_panther
-- Original migration: 0007_happy_black_panther.sql
-- Risk level: LOW
-- Data loss: NO
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the changes made by 0007_happy_black_panther.sql
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed

-- Operations:
-- - Drops index "album_id_idx"

-- BEGIN ROLLBACK

-- Drops index "album_id_idx"
DROP INDEX IF EXISTS "album_id_idx";

-- END ROLLBACK
