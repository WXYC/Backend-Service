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
	"shows_covered" smallint DEFAULT 0 NOT NULL,
	"add_date" date DEFAULT now() NOT NULL,
	CONSTRAINT "djs_dj_name_unique" UNIQUE("dj_name"),
	CONSTRAINT "djs_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."flowsheet" (
	"id" serial PRIMARY KEY NOT NULL,
	"show_id" integer NOT NULL,
	"album_id" integer,
	"rotation_id" integer,
	"track_title" varchar(128) NOT NULL,
	"album_title" varchar(128) NOT NULL,
	"artist_name" varchar(128) NOT NULL,
	"record_label" varchar(128),
	"play_order" serial NOT NULL,
	"request_flag" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."format" (
	"id" serial PRIMARY KEY NOT NULL,
	"format_name" varchar NOT NULL,
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
	"label" varchar(128),
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
	"review" text,
	"add_date" date DEFAULT now() NOT NULL,
	"last_modified" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_album_id_unique" UNIQUE("album_id")
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
CREATE TABLE IF NOT EXISTS "wxyc_schema"."schedule" (
	"id" serial PRIMARY KEY NOT NULL,
	"day" smallint NOT NULL,
	"start_time" time NOT NULL,
	"show_duration" smallint NOT NULL,
	"specialty_id" integer,
	"assigned_dj_id" integer,
	"assigned_dj_id2" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."shift_covers" (
	"id" serial PRIMARY KEY NOT NULL,
	"schedule_id" serial NOT NULL,
	"shift_timestamp" timestamp NOT NULL,
	"cover_dj_id" integer,
	"covered" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wxyc_schema"."shows" (
	"id" serial PRIMARY KEY NOT NULL,
	"dj_id" integer NOT NULL,
	"dj_id2" integer,
	"dj_id3" integer,
	"specialty_id" integer,
	"show_name" varchar(128),
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
CREATE INDEX IF NOT EXISTS "genre_id_idx" ON "wxyc_schema"."library" ("genre_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "format_id_idx" ON "wxyc_schema"."library" ("format_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artist_id_idx" ON "wxyc_schema"."library" ("artist_id");--> statement-breakpoint
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
 ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_specialty_id_specialty_shows_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "wxyc_schema"."specialty_shows"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_assigned_dj_id_djs_id_fk" FOREIGN KEY ("assigned_dj_id") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_assigned_dj_id2_djs_id_fk" FOREIGN KEY ("assigned_dj_id2") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shift_covers" ADD CONSTRAINT "shift_covers_schedule_id_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "wxyc_schema"."schedule"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shift_covers" ADD CONSTRAINT "shift_covers_cover_dj_id_djs_id_fk" FOREIGN KEY ("cover_dj_id") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
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
