CREATE TABLE "wxyc_schema"."labels" (
	"id" serial PRIMARY KEY NOT NULL,
	"label_name" varchar(128) NOT NULL,
	"parent_label_id" integer,
	CONSTRAINT "labels_label_name_unique" UNIQUE("label_name")
);
--> statement-breakpoint
DROP VIEW "wxyc_schema"."library_artist_view";--> statement-breakpoint
DROP VIEW "wxyc_schema"."rotation_library_view";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ALTER COLUMN "last_accessed" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ALTER COLUMN "last_accessed" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_metadata" ALTER COLUMN "last_accessed" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_metadata" ALTER COLUMN "last_accessed" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_metadata" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_metadata" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artists" ALTER COLUMN "last_modified" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artists" ALTER COLUMN "last_modified" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "add_time" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "add_time" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "wxyc_schema"."genres" ALTER COLUMN "last_modified" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."genres" ALTER COLUMN "last_modified" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ALTER COLUMN "add_date" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ALTER COLUMN "add_date" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ALTER COLUMN "last_modified" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ALTER COLUMN "last_modified" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ALTER COLUMN "last_modified" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ALTER COLUMN "last_modified" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shift_covers" ALTER COLUMN "schedule_id" SET DATA TYPE integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shift_covers" ALTER COLUMN "shift_timestamp" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ALTER COLUMN "start_time" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ALTER COLUMN "start_time" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ALTER COLUMN "end_time" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ALTER COLUMN "last_modified" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ALTER COLUMN "last_modified" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "label_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ADD COLUMN "label_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "wxyc_schema"."labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ADD CONSTRAINT "library_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "wxyc_schema"."labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "show_djs_show_id_dj_id_unique" ON "wxyc_schema"."show_djs" USING btree ("show_id","dj_id");--> statement-breakpoint
CREATE VIEW "wxyc_schema"."library_artist_view" AS (select "wxyc_schema"."library"."id", "wxyc_schema"."artists"."code_letters", "wxyc_schema"."genre_artist_crossreference"."artist_genre_code", "wxyc_schema"."library"."code_number", "wxyc_schema"."artists"."artist_name", "wxyc_schema"."artists"."alphabetical_name", "wxyc_schema"."library"."album_title", "wxyc_schema"."format"."format_name", "wxyc_schema"."genres"."genre_name", "wxyc_schema"."rotation"."rotation_bin", "wxyc_schema"."library"."add_date", "wxyc_schema"."library"."label", "wxyc_schema"."library"."label_id" from "wxyc_schema"."library" inner join "wxyc_schema"."artists" on "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id" inner join "wxyc_schema"."format" on "wxyc_schema"."format"."id" = "wxyc_schema"."library"."format_id" inner join "wxyc_schema"."genres" on "wxyc_schema"."genres"."id" = "wxyc_schema"."library"."genre_id" inner join "wxyc_schema"."genre_artist_crossreference" on ("wxyc_schema"."genre_artist_crossreference"."artist_id" = "wxyc_schema"."library"."artist_id" and "wxyc_schema"."genre_artist_crossreference"."genre_id" = "wxyc_schema"."library"."genre_id") left join "wxyc_schema"."rotation" on "wxyc_schema"."rotation"."album_id" = "wxyc_schema"."library"."id" AND ("wxyc_schema"."rotation"."kill_date" > CURRENT_DATE OR "wxyc_schema"."rotation"."kill_date" IS NULL));--> statement-breakpoint
CREATE VIEW "wxyc_schema"."rotation_library_view" AS (select "wxyc_schema"."library"."id" AS "library_id", "wxyc_schema"."rotation"."id" AS "rotation_id", "wxyc_schema"."library"."label", "wxyc_schema"."library"."label_id", "wxyc_schema"."rotation"."rotation_bin", "wxyc_schema"."library"."album_title", "wxyc_schema"."artists"."artist_name", "wxyc_schema"."artists"."alphabetical_name", "wxyc_schema"."rotation"."kill_date" from "wxyc_schema"."library" inner join "wxyc_schema"."rotation" on "wxyc_schema"."library"."id" = "wxyc_schema"."rotation"."album_id" inner join "wxyc_schema"."artists" on "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id");