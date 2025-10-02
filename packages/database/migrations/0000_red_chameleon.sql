CREATE SCHEMA "wxyc_schema";
--> statement-breakpoint
CREATE TYPE "public"."freq_enum" AS ENUM('S', 'L', 'M', 'H');--> statement-breakpoint
CREATE TABLE "wxyc_schema"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."artists" (
	"id" serial PRIMARY KEY NOT NULL,
	"genre_id" integer NOT NULL,
	"artist_name" varchar(128) NOT NULL,
	"code_letters" varchar(2) NOT NULL,
	"code_artist_number" smallint NOT NULL,
	"add_date" date DEFAULT now() NOT NULL,
	"last_modified" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."bins" (
	"id" serial PRIMARY KEY NOT NULL,
	"dj_id" varchar(255) NOT NULL,
	"album_id" integer NOT NULL,
	"track_title" varchar(128)
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."flowsheet" (
	"id" serial PRIMARY KEY NOT NULL,
	"show_id" integer,
	"album_id" integer,
	"rotation_id" integer,
	"track_title" varchar(128),
	"album_title" varchar(128),
	"artist_name" varchar(128),
	"record_label" varchar(128),
	"play_order" integer NOT NULL,
	"request_flag" boolean DEFAULT false NOT NULL,
	"message" varchar(250),
	"add_time" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."format" (
	"id" serial PRIMARY KEY NOT NULL,
	"format_name" varchar NOT NULL,
	"add_date" date DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."genres" (
	"id" serial PRIMARY KEY NOT NULL,
	"genre_name" varchar(64) NOT NULL,
	"description" text,
	"plays" integer DEFAULT 0 NOT NULL,
	"add_date" date DEFAULT now() NOT NULL,
	"last_modified" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."jwks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."library" (
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
CREATE TABLE "wxyc_schema"."member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer NOT NULL,
	"review" text,
	"add_date" date DEFAULT now() NOT NULL,
	"last_modified" timestamp DEFAULT now() NOT NULL,
	"author" varchar(32),
	CONSTRAINT "reviews_album_id_unique" UNIQUE("album_id")
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."rotation" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer NOT NULL,
	"play_freq" "freq_enum" NOT NULL,
	"add_date" date DEFAULT now() NOT NULL,
	"kill_date" date
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."schedule" (
	"id" serial PRIMARY KEY NOT NULL,
	"day" smallint NOT NULL,
	"start_time" time NOT NULL,
	"show_duration" smallint NOT NULL,
	"specialty_id" integer,
	"assigned_dj_id" varchar(255),
	"assigned_dj_id2" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."shift_covers" (
	"id" serial PRIMARY KEY NOT NULL,
	"schedule_id" integer NOT NULL,
	"shift_timestamp" timestamp NOT NULL,
	"cover_dj_id" varchar(255),
	"covered" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."show_djs" (
	"show_id" integer NOT NULL,
	"dj_id" varchar(255) NOT NULL,
	"active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."shows" (
	"id" serial PRIMARY KEY NOT NULL,
	"primary_dj_id" varchar(255),
	"specialty_id" integer,
	"show_name" varchar(128),
	"start_time" timestamp DEFAULT now() NOT NULL,
	"end_time" timestamp
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."specialty_shows" (
	"id" serial PRIMARY KEY NOT NULL,
	"specialty_name" varchar(64) NOT NULL,
	"description" text,
	"add_date" date DEFAULT now() NOT NULL,
	"last_modified" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	"username" text,
	"display_username" text,
	"real_name" text,
	"dj_name" text,
	"app_skin" text NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "wxyc_schema"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artists" ADD CONSTRAINT "artists_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "wxyc_schema"."genres"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."bins" ADD CONSTRAINT "bins_dj_id_user_id_fk" FOREIGN KEY ("dj_id") REFERENCES "wxyc_schema"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."bins" ADD CONSTRAINT "bins_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "wxyc_schema"."shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_rotation_id_rotation_id_fk" FOREIGN KEY ("rotation_id") REFERENCES "wxyc_schema"."rotation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "wxyc_schema"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "wxyc_schema"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ADD CONSTRAINT "library_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ADD CONSTRAINT "library_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "wxyc_schema"."genres"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ADD CONSTRAINT "library_format_id_format_id_fk" FOREIGN KEY ("format_id") REFERENCES "wxyc_schema"."format"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "wxyc_schema"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "wxyc_schema"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD CONSTRAINT "reviews_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."rotation" ADD CONSTRAINT "rotation_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_specialty_id_specialty_shows_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "wxyc_schema"."specialty_shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_assigned_dj_id_user_id_fk" FOREIGN KEY ("assigned_dj_id") REFERENCES "wxyc_schema"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_assigned_dj_id2_user_id_fk" FOREIGN KEY ("assigned_dj_id2") REFERENCES "wxyc_schema"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "wxyc_schema"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shift_covers" ADD CONSTRAINT "shift_covers_schedule_id_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "wxyc_schema"."schedule"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shift_covers" ADD CONSTRAINT "shift_covers_cover_dj_id_user_id_fk" FOREIGN KEY ("cover_dj_id") REFERENCES "wxyc_schema"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."show_djs" ADD CONSTRAINT "show_djs_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "wxyc_schema"."shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."show_djs" ADD CONSTRAINT "show_djs_dj_id_user_id_fk" FOREIGN KEY ("dj_id") REFERENCES "wxyc_schema"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_primary_dj_id_user_id_fk" FOREIGN KEY ("primary_dj_id") REFERENCES "wxyc_schema"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_specialty_id_specialty_shows_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "wxyc_schema"."specialty_shows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artist_name_trgm_idx" ON "wxyc_schema"."artists" USING gin ("artist_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "code_letters_idx" ON "wxyc_schema"."artists" USING btree ("code_letters");--> statement-breakpoint
CREATE INDEX "title_trgm_idx" ON "wxyc_schema"."library" USING gin ("album_title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "genre_id_idx" ON "wxyc_schema"."library" USING btree ("genre_id");--> statement-breakpoint
CREATE INDEX "format_id_idx" ON "wxyc_schema"."library" USING btree ("format_id");--> statement-breakpoint
CREATE INDEX "artist_id_idx" ON "wxyc_schema"."library" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX "album_id_idx" ON "wxyc_schema"."rotation" USING btree ("album_id");--> statement-breakpoint
CREATE VIEW "wxyc_schema"."library_artist_view" AS (select "wxyc_schema"."library"."id", "wxyc_schema"."artists"."code_letters", "wxyc_schema"."artists"."code_artist_number", "wxyc_schema"."library"."code_number", "wxyc_schema"."artists"."artist_name", "wxyc_schema"."library"."album_title", "wxyc_schema"."format"."format_name", "wxyc_schema"."genres"."genre_name", "wxyc_schema"."rotation"."play_freq", "wxyc_schema"."library"."add_date", "wxyc_schema"."library"."label" from "wxyc_schema"."library" inner join "wxyc_schema"."artists" on "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id" inner join "wxyc_schema"."format" on "wxyc_schema"."format"."id" = "wxyc_schema"."library"."format_id" inner join "wxyc_schema"."genres" on "wxyc_schema"."genres"."id" = "wxyc_schema"."library"."genre_id" left join "wxyc_schema"."rotation" on "wxyc_schema"."rotation"."album_id" = "wxyc_schema"."library"."id" AND ("wxyc_schema"."rotation"."kill_date" < CURRENT_DATE OR "wxyc_schema"."rotation"."kill_date" IS NULL));--> statement-breakpoint
CREATE VIEW "wxyc_schema"."rotation_library_view" AS (select "wxyc_schema"."library"."id" as "library_id", "wxyc_schema"."rotation"."id" as "rotation_id", "wxyc_schema"."library"."label", "wxyc_schema"."rotation"."play_freq", "wxyc_schema"."library"."album_title", "wxyc_schema"."artists"."artist_name", "wxyc_schema"."rotation"."kill_date" from "wxyc_schema"."library" inner join "wxyc_schema"."rotation" on "wxyc_schema"."library"."id" = "wxyc_schema"."rotation"."album_id" inner join "wxyc_schema"."artists" on "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id");