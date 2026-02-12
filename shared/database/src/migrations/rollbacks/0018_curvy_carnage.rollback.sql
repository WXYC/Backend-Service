-- Rollback: 0018_curvy_carnage
-- Original migration: 0018_curvy_carnage.sql
-- Risk level: LOW
-- Data loss: NO
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the changes made by 0018_curvy_carnage.sql
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed

-- Operations:
-- - Drops index "artist_name_trgm_idx"
-- - Drops index "title_trgm_idx"

-- BEGIN ROLLBACK

-- Drops index "artist_name_trgm_idx"
DROP INDEX IF EXISTS "artist_name_trgm_idx";

-- Drops index "title_trgm_idx"
DROP INDEX IF EXISTS "title_trgm_idx";

-- END ROLLBACK
