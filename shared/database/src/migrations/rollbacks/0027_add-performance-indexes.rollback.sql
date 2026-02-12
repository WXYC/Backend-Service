-- Rollback: 0027_add-performance-indexes
-- Original migration: 0027_add-performance-indexes.sql
-- Risk level: LOW
-- Data loss: NO
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the changes made by 0027_add-performance-indexes.sql
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed

-- Operations:
-- - Drops index "bins_dj_id_idx"
-- - Drops index "bins_album_id_idx"
-- - Drops index "flowsheet_show_id_idx"
-- - Drops index "flowsheet_album_id_idx"
-- - Drops index "flowsheet_rotation_id_idx"
-- - Drops index "show_djs_show_id_dj_id_idx"
-- - Drops index "show_djs_dj_id_idx"

-- BEGIN ROLLBACK

-- Drops index "bins_dj_id_idx"
DROP INDEX IF EXISTS "bins_dj_id_idx";

-- Drops index "bins_album_id_idx"
DROP INDEX IF EXISTS "bins_album_id_idx";

-- Drops index "flowsheet_show_id_idx"
DROP INDEX IF EXISTS "flowsheet_show_id_idx";

-- Drops index "flowsheet_album_id_idx"
DROP INDEX IF EXISTS "flowsheet_album_id_idx";

-- Drops index "flowsheet_rotation_id_idx"
DROP INDEX IF EXISTS "flowsheet_rotation_id_idx";

-- Drops index "show_djs_show_id_dj_id_idx"
DROP INDEX IF EXISTS "show_djs_show_id_dj_id_idx";

-- Drops index "show_djs_dj_id_idx"
DROP INDEX IF EXISTS "show_djs_dj_id_idx";

-- END ROLLBACK
