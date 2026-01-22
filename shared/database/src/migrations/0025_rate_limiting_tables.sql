-- album_metadata and artist_metadata tables already created in 0023_metadata_tables.sql
--> statement-breakpoint
CREATE TABLE "user_activity" (
	"user_id" varchar(255) PRIMARY KEY NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "is_anonymous" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Constraints and indexes for album_metadata and artist_metadata already created in 0023_metadata_tables.sql
ALTER TABLE "user_activity" ADD CONSTRAINT "user_activity_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;