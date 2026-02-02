-- Rollback: 0000_rare_prima
-- Original migration: 0000_rare_prima.sql
-- Risk level: HIGH
-- Data loss: YES
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the changes made by 0000_rare_prima.sql
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed
-- [ ] Maintenance window scheduled

-- Operations:
-- - Drops type "freq_enum"
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Drops table "wxyc_schema" (DATA LOSS)
-- - Drops index "genre_id_idx"
-- - Drops index "format_id_idx"
-- - Drops index "artist_id_idx"

-- BEGIN ROLLBACK

-- Drops type "freq_enum"
DROP TYPE IF EXISTS "freq_enum" CASCADE;

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Drops table "wxyc_schema" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema" CASCADE;

-- Drops index "genre_id_idx"
DROP INDEX IF EXISTS "genre_id_idx";

-- Drops index "format_id_idx"
DROP INDEX IF EXISTS "format_id_idx";

-- Drops index "artist_id_idx"
DROP INDEX IF EXISTS "artist_id_idx";

-- END ROLLBACK
