DO $$ BEGIN
 CREATE TYPE "format_enum" AS ENUM('cd', 'cdr', 'vinyl', 'vinyl - 12"', 'vinyl - 7"', 'vinyl - LP');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "freq_enum" AS ENUM('single', 'light', 'medium', 'heavy');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artists" (
	"id" serial PRIMARY KEY NOT NULL,
	"artist_name" varchar(128),
	"code_letters" varchar(2),
	"code_artist_number" smallint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bins" (
	"id" serial PRIMARY KEY NOT NULL,
	"dj_id" smallint,
	"album_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "djs" (
	"id" serial PRIMARY KEY NOT NULL,
	"dj_name" varchar NOT NULL,
	"real_name" varchar NOT NULL,
	"email" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flowsheet" (
	"id" serial PRIMARY KEY NOT NULL,
	"show_id" integer,
	"album_id" integer,
	"rotation_id" smallint,
	"track_title" varchar(128),
	"entry_timestamp" timestamp,
	"request_flag" boolean
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "genres" (
	"id" serial PRIMARY KEY NOT NULL,
	"genre_name" varchar,
	"description" text,
	"plays" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "library" (
	"id" serial PRIMARY KEY NOT NULL,
	"artist_id" integer,
	"genre_id" smallint,
	"album_title" varchar(128),
	"label" varchar(128),
	"code_number" smallint,
	"format_flag" boolean,
	"format" "format_enum",
	"add_date" timestamp,
	"plays" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer,
	"review" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rotation" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer,
	"play_freq" "freq_enum",
	"add_date" date,
	"kill_date" date,
	"is_active" boolean
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shows" (
	"id" serial PRIMARY KEY NOT NULL,
	"dj_id" smallint,
	"dj_id2" smallint,
	"dj_id3" smallint,
	"specialty_id" smallint,
	"show_name" varchar(128),
	"start_time" timestamp,
	"end_time" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "specialty_shows" (
	"id" serial PRIMARY KEY NOT NULL,
	"specialty_name" varchar(64),
	"description" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_idx" ON "djs" ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "title_idx" ON "library" ("album_title");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bins" ADD CONSTRAINT "bins_dj_id_djs_id_fk" FOREIGN KEY ("dj_id") REFERENCES "djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bins" ADD CONSTRAINT "bins_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "library"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flowsheet" ADD CONSTRAINT "flowsheet_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "shows"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flowsheet" ADD CONSTRAINT "flowsheet_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "library"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flowsheet" ADD CONSTRAINT "flowsheet_rotation_id_rotation_id_fk" FOREIGN KEY ("rotation_id") REFERENCES "rotation"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "library" ADD CONSTRAINT "library_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "library" ADD CONSTRAINT "library_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "genres"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reviews" ADD CONSTRAINT "reviews_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "library"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rotation" ADD CONSTRAINT "rotation_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "library"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shows" ADD CONSTRAINT "shows_dj_id_djs_id_fk" FOREIGN KEY ("dj_id") REFERENCES "djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shows" ADD CONSTRAINT "shows_dj_id2_djs_id_fk" FOREIGN KEY ("dj_id2") REFERENCES "djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shows" ADD CONSTRAINT "shows_dj_id3_djs_id_fk" FOREIGN KEY ("dj_id3") REFERENCES "djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shows" ADD CONSTRAINT "shows_specialty_id_specialty_shows_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "specialty_shows"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
