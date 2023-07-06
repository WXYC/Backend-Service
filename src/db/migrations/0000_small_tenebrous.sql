CREATE SCHEMA "wxyc_schema";
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "freq_enum" AS ENUM('S', 'L', 'M', 'H');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."artists" (
	"id" serial PRIMARY KEY NOT NULL,
	"artist_name" varchar(128) NOT NULL,
	"code_letters" varchar(2) NOT NULL,
	"code_artist_number" smallint NOT NULL,
	"add_date" date DEFAULT now() NOT NULL,
	"last_modified" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."bins" (
	"id" serial PRIMARY KEY NOT NULL,
	"dj_id" integer NOT NULL,
	"album_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."djs" (
	"id" serial PRIMARY KEY NOT NULL,
	"dj_name" varchar NOT NULL,
	"real_name" varchar NOT NULL,
	"email" varchar NOT NULL,
	"add_date" date DEFAULT now() NOT NULL,
	"last_modified" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."flowsheet" (
	"id" serial PRIMARY KEY NOT NULL,
	"show_id" integer NOT NULL,
	"album_id" integer NOT NULL,
	"rotation_id" integer NOT NULL,
	"track_title" varchar(128) NOT NULL,
	"album_title" varchar(128) NOT NULL,
	"record_label" varchar(128) NOT NULL,
	"play_order" serial NOT NULL,
	"play_timestamp" timestamp DEFAULT now() NOT NULL,
	"request_flag" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."format" (
	"id" serial PRIMARY KEY NOT NULL,
	"format_name" varchar NOT NULL,
	"is_vinyl" boolean NOT NULL,
	"add_date" date DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."genres" (
	"id" serial PRIMARY KEY NOT NULL,
	"genre_name" varchar(64) NOT NULL,
	"description" text,
	"plays" integer DEFAULT 0 NOT NULL,
	"add_date" date DEFAULT now() NOT NULL,
	"last_modified" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."library" (
	"id" serial PRIMARY KEY NOT NULL,
	"artist_id" integer NOT NULL,
	"genre_id" integer NOT NULL,
	"format_id" integer NOT NULL,
	"alternate_artist_name" varchar(128),
	"album_title" varchar(128) NOT NULL,
	"label" varchar(128) NOT NULL,
	"code_number" smallint NOT NULL,
	"disc_quantity" smallint DEFAULT 1 NOT NULL,
	"plays" integer DEFAULT 0 NOT NULL,
	"add_date" timestamp DEFAULT now() NOT NULL,
	"last_modified" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer NOT NULL,
	"review" text NOT NULL,
	"add_date" date DEFAULT now() NOT NULL,
	"last_modified" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."rotation" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer NOT NULL,
	"play_freq" "freq_enum" NOT NULL,
	"add_date" date NOT NULL,
	"kill_date" date,
	"is_active" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."shows" (
	"id" serial PRIMARY KEY NOT NULL,
	"dj_id" integer NOT NULL,
	"dj_id2" integer,
	"dj_id3" integer,
	"specialty_id" integer NOT NULL,
	"show_name" varchar(128) NOT NULL,
	"start_time" timestamp DEFAULT now() NOT NULL,
	"end_time" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."specialty_shows" (
	"id" serial PRIMARY KEY NOT NULL,
	"specialty_name" varchar(64) NOT NULL,
	"description" text,
	"add_date" date DEFAULT now() NOT NULL,
	"last_modified" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artist_name_idx" ON "wxyc_schema"."artists" ("artist_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_idx" ON "wxyc_schema"."djs" ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "title_idx" ON "wxyc_schema"."library" ("album_title");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."bins" ADD CONSTRAINT "bins_dj_id_djs_id_fk" FOREIGN KEY ("dj_id") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."bins" ADD CONSTRAINT "bins_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "wxyc_schema"."shows"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_rotation_id_rotation_id_fk" FOREIGN KEY ("rotation_id") REFERENCES "wxyc_schema"."rotation"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."library" ADD CONSTRAINT "library_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."library" ADD CONSTRAINT "library_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "wxyc_schema"."genres"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."library" ADD CONSTRAINT "library_format_id_format_id_fk" FOREIGN KEY ("format_id") REFERENCES "wxyc_schema"."format"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."reviews" ADD CONSTRAINT "reviews_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."rotation" ADD CONSTRAINT "rotation_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_dj_id_djs_id_fk" FOREIGN KEY ("dj_id") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_dj_id2_djs_id_fk" FOREIGN KEY ("dj_id2") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_dj_id3_djs_id_fk" FOREIGN KEY ("dj_id3") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_specialty_id_specialty_shows_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "wxyc_schema"."specialty_shows"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
