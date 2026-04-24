-- Tables without a primary key need explicit REPLICA IDENTITY when a
-- FOR ALL TABLES publication exists (wxyc_cdc).  Without it, PostgreSQL
-- rejects DELETE and UPDATE operations with:
--   "cannot delete from table … because it does not have a replica identity
--    and publishes deletes"
--
-- Use the existing unique index where available; fall back to FULL.

ALTER TABLE wxyc_schema.show_djs REPLICA IDENTITY USING INDEX show_djs_show_id_dj_id_unique;
--> statement-breakpoint
ALTER TABLE wxyc_schema.artist_library_crossreference REPLICA IDENTITY FULL;
--> statement-breakpoint
ALTER TABLE wxyc_schema.genre_artist_crossreference REPLICA IDENTITY USING INDEX artist_genre_key;
--> statement-breakpoint
ALTER TABLE wxyc_schema.artist_crossreference REPLICA IDENTITY USING INDEX artist_crossref_source_target;
