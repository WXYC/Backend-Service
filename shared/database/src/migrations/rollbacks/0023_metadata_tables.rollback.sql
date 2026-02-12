-- Rollback: 0023_metadata_tables
-- Original migration: 0023_metadata_tables.sql
-- Risk level: HIGH
-- Data loss: YES
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the changes made by 0023_metadata_tables.sql
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed
-- [ ] Maintenance window scheduled

-- Operations:
-- - Drops table "wxyc_schema"."album_metadata" (DATA LOSS)
-- - Drops table "wxyc_schema"."artist_metadata" (DATA LOSS)
-- - Drops index "album_metadata_album_id_idx"
-- - Drops index "album_metadata_cache_key_idx"
-- - Drops index "album_metadata_last_accessed_idx"
-- - Drops index "artist_metadata_artist_id_idx"
-- - Drops index "artist_metadata_cache_key_idx"
-- - Drops index "artist_metadata_last_accessed_idx"

-- BEGIN ROLLBACK

-- Drops table "wxyc_schema"."album_metadata" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema"."album_metadata" CASCADE;

-- Drops table "wxyc_schema"."artist_metadata" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema"."artist_metadata" CASCADE;

-- Drops index "album_metadata_album_id_idx"
DROP INDEX IF EXISTS "album_metadata_album_id_idx";

-- Drops index "album_metadata_cache_key_idx"
DROP INDEX IF EXISTS "album_metadata_cache_key_idx";

-- Drops index "album_metadata_last_accessed_idx"
DROP INDEX IF EXISTS "album_metadata_last_accessed_idx";

-- Drops index "artist_metadata_artist_id_idx"
DROP INDEX IF EXISTS "artist_metadata_artist_id_idx";

-- Drops index "artist_metadata_cache_key_idx"
DROP INDEX IF EXISTS "artist_metadata_cache_key_idx";

-- Drops index "artist_metadata_last_accessed_idx"
DROP INDEX IF EXISTS "artist_metadata_last_accessed_idx";

-- END ROLLBACK
