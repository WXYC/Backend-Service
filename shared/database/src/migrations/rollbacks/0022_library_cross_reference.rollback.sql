-- Rollback: 0022_library_cross_reference
-- Original migration: 0022_library_cross_reference.sql
-- Risk level: HIGH
-- Data loss: YES
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the changes made by 0022_library_cross_reference.sql
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed
-- [ ] Maintenance window scheduled

-- Operations:
-- - Drops table "wxyc_schema"."artist_library_crossreference" (DATA LOSS)
-- - Drops table "wxyc_schema"."genre_artist_crossreference" (DATA LOSS)
-- - Drops index "library_id_artist_id"
-- - Drops index "artist_genre_key"

-- BEGIN ROLLBACK

-- Drops table "wxyc_schema"."artist_library_crossreference" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema"."artist_library_crossreference" CASCADE;

-- Drops table "wxyc_schema"."genre_artist_crossreference" (DATA LOSS)
DROP TABLE IF EXISTS "wxyc_schema"."genre_artist_crossreference" CASCADE;

-- Drops index "library_id_artist_id"
DROP INDEX IF EXISTS "library_id_artist_id";

-- Drops index "artist_genre_key"
DROP INDEX IF EXISTS "artist_genre_key";

-- END ROLLBACK
