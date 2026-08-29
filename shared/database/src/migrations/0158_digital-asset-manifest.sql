-- BS#2318 (epic WXYC/wxyc-dj-ios#135, digital archive) — the digital-asset
-- manifest substrate: which `library.id`s have audio, in which store, under
-- what object keys, with what codec and checksums. Generalized so today's
-- hand-uploaded auto-DJ MP3s (`digital_asset.provenance = 'rotation_upload'`)
-- and tomorrow's verified CD rips (`'cd_rip'`) are rows in the same tables
-- rather than two schemas — the rip-evidence columns on `digital_asset` are
-- ALL nullable now precisely so the CD-rip phase adds rows, not columns. See
-- `plans/digital-archive/cd-library-digitization.md` §13.1 and
-- `plans/digital-archive/auto-dj-archive-player.md` §5.1 for the design.
--
-- Four tables, all fresh CREATE TABLEs, additive only:
--   digital_asset_store         -- storage backends (endpoint/bucket/creds are
--                                   env, keyed by `name`)
--   digital_asset                -- one row per (library_id, provenance,
--                                   disc_number); review/bind status +
--                                   nullable rip evidence
--   digital_asset_file           -- one row per physical file backing an
--                                   asset; codec + checksums + raw tags
--   catalog_export_flag_state    -- last-seen value of each env flag whose
--                                   flip changes the catalog export
--                                   projection, so a startup hook (BS#2320)
--                                   can detect the flip and call
--                                   `touch_library_watermark_now()`
--
-- WXYC/Backend-Service#2319 writes `digital_asset`/`digital_asset_file` rows;
-- WXYC/Backend-Service#2320 reads them, calls the watermark wrapper (shipped
-- separately, migration 0159) at startup, and projects the export column. No
-- data backfill here.
--
-- @no-precondition-needed: every constraint below (the two UNIQUE composite
-- indexes, the four FOREIGN KEYs, the NOT NULLs) is on a table this migration
-- creates. There is no existing data to violate a fresh table's constraints.
-- @no-analyze-needed: DDL only — CREATE TABLE, ADD CONSTRAINT, CREATE INDEX.
-- No UPDATE/INSERT statement in this migration.

CREATE TABLE "wxyc_schema"."catalog_export_flag_state" (
	"name" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."digital_asset" (
	"id" serial PRIMARY KEY NOT NULL,
	"library_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"disc_number" smallint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'needs_review' NOT NULL,
	"bind_note" text,
	"verification_method" text,
	"accuraterip_confidence" integer,
	"c2_error_count" integer,
	"has_htoa" boolean,
	"hdcd" boolean,
	"pre_emphasis" boolean,
	"has_data_session" boolean,
	"has_subchannel" boolean,
	"identity_qc_flag" text,
	"rip_log_key" text,
	"cue_sheet_key" text,
	"toc_key" text,
	"data_session_key" text,
	"album_gain_db" real,
	"ripped_by" varchar(255),
	"ripped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."digital_asset_file" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"store_id" integer NOT NULL,
	"object_key" text NOT NULL,
	"codec" text NOT NULL,
	"bitrate_kbps" integer,
	"track_number" smallint,
	"title" text NOT NULL,
	"duration_secs" real,
	"bytes" bigint NOT NULL,
	"md5" char(32),
	"sha256" char(64),
	"flac_md5" char(32),
	"tag_artist" text,
	"tag_album" text,
	"tag_track" text
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."digital_asset_store" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."digital_asset" ADD CONSTRAINT "digital_asset_library_id_library_id_fk" FOREIGN KEY ("library_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."digital_asset" ADD CONSTRAINT "digital_asset_ripped_by_auth_user_id_fk" FOREIGN KEY ("ripped_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."digital_asset_file" ADD CONSTRAINT "digital_asset_file_asset_id_digital_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "wxyc_schema"."digital_asset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."digital_asset_file" ADD CONSTRAINT "digital_asset_file_store_id_digital_asset_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "wxyc_schema"."digital_asset_store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "digital_asset_library_provenance_disc_idx" ON "wxyc_schema"."digital_asset" USING btree ("library_id","provenance","disc_number");--> statement-breakpoint
CREATE INDEX "digital_asset_library_status_idx" ON "wxyc_schema"."digital_asset" USING btree ("library_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_asset_file_store_object_key_idx" ON "wxyc_schema"."digital_asset_file" USING btree ("store_id","object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "digital_asset_store_name_idx" ON "wxyc_schema"."digital_asset_store" USING btree ("name");