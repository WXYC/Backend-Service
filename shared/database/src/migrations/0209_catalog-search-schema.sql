-- BS#3740: catalog search schema, step 3 of BS#3738.
--
-- Adds two tables and two trigram indexes. Nothing reads or writes the tables
-- yet.
--
--   - library_track_index: the narrow table the matcher's track levels read.
--     One row per library record: library_id (PK, FK library.id ON DELETE
--     CASCADE) and search_doc, a 'simple'-config tsvector, with a GIN index.
--   - library_track_data: the sibling holding the track list and provenance
--     (source, source_batch, discogs_release_id, tracks jsonb, fingerprint,
--     refreshed_at), same PK and FK. A record has a row in both tables or in
--     neither. A CHECK limits source to 'compilation', 'override' and
--     'album_metadata'.
--   - Why two tables: a common word makes Postgres scan the whole track table,
--     and with the jsonb in the same row that scan reads every jsonb. Split,
--     levels 4 and 5 took 7 ms instead of 44 ms for "love" (BS#3739).
--   - Why not a library column: a nightly writer would fire the per-row
--     cdc_library trigger (0046) once per record.
--   - library_track_index and library_track_data are empty, so their indexes are
--     plain CREATE INDEX.
--
-- @no-precondition-needed: both tables are new and empty, so the foreign keys
-- have no existing rows to violate, and so does the CHECK on source.
--
-- library_label_trgm_idx and library_alternate_artist_name_trgm_idx serve
-- level 3 of the matcher (ILIKE '%w%' on label and alternate_artist_name), which
-- is a full scan of library without them (108-129 ms per word on prod).
--
-- Production ops (run BEFORE merging; the deploy runs migrations automatically):
--   - These statements are NOT `CREATE INDEX CONCURRENTLY` below because the
--     migrator runs every pending migration inside a single transaction, and
--     `CREATE INDEX CONCURRENTLY cannot run inside a transaction block`. A plain
--     build on library takes a ShareLock for its whole duration and queues
--     every concurrent write.
--   - Build both indexes out-of-band on prod first, one statement at a time (no
--     AccessExclusiveLock, no write pause):
--       CREATE INDEX CONCURRENTLY IF NOT EXISTS "library_label_trgm_idx"
--         ON "wxyc_schema"."library" USING gin ("label" gin_trgm_ops);
--       CREATE INDEX CONCURRENTLY IF NOT EXISTS "library_alternate_artist_name_trgm_idx"
--         ON "wxyc_schema"."library" USING gin ("alternate_artist_name" gin_trgm_ops);
--   - A CONCURRENTLY build that fails or is cancelled leaves an INVALID index
--     behind, and `IF NOT EXISTS` would then skip it. Check
--     `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`, and
--     DROP INDEX CONCURRENTLY any invalid leftover before rebuilding.
--   - Then merge. `IF NOT EXISTS` makes the two trigram statements a no-op
--     against the prod DB where the indexes already exist, while fresh dev
--     databases pick them up on first migrate. Same shape as 0057, 0068, 0070
--     and 0206.

CREATE TABLE "wxyc_schema"."library_track_data" (
	"library_id" integer PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_batch" text,
	"discogs_release_id" integer,
	"tracks" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_track_data_source_check" CHECK ("wxyc_schema"."library_track_data"."source" IN ('compilation', 'override', 'album_metadata'))
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."library_track_index" (
	"library_id" integer PRIMARY KEY NOT NULL,
	"search_doc" "tsvector" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library_track_data" ADD CONSTRAINT "library_track_data_library_id_library_id_fk" FOREIGN KEY ("library_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library_track_index" ADD CONSTRAINT "library_track_index_library_id_library_id_fk" FOREIGN KEY ("library_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_track_index_search_doc_idx" ON "wxyc_schema"."library_track_index" USING gin ("search_doc");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_label_trgm_idx" ON "wxyc_schema"."library" USING gin ("label" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_alternate_artist_name_trgm_idx" ON "wxyc_schema"."library" USING gin ("alternate_artist_name" gin_trgm_ops);