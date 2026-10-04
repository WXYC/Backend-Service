-- BS#2801 (slice 9 of BS#2791) -- extend `reviews` for many per release, reviews that precede the library row (`intake_item_id`), authorship by account or text, drafts, the slip's fields and per-surface consent.
--
-- `reviews` held 0 rows in production on 2026-10-02, so nothing is carried. `status` defaults to `submitted` so a `reviews` row inside a delete snapshot written before this migration restores as submitted (restore inserts only the captured columns). Dropping `UNIQUE (album_id)` drops its index, so `reviews_album_id_idx` replaces it.
--
-- @no-precondition-needed: every existing row has `album_id` NOT NULL, so `reviews_target_ck` cannot be violated; the new columns are nullable or defaulted, and the new FKs are on columns that are NULL for every existing row.
CREATE TYPE "wxyc_schema"."review_credit" AS ENUM('dj_name', 'real_name', 'none');--> statement-breakpoint
CREATE TYPE "wxyc_schema"."review_medium" AS ENUM('typed', 'handwritten', 'printed');--> statement-breakpoint
CREATE TYPE "wxyc_schema"."review_status" AS ENUM('draft', 'submitted');--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" DROP CONSTRAINT "reviews_album_id_unique";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ALTER COLUMN "album_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ALTER COLUMN "author" SET DATA TYPE varchar(128);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "intake_item_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "author_user_id" varchar(255);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "recorded_by_user_id" varchar(255);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "medium" "wxyc_schema"."review_medium" DEFAULT 'typed' NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "artist_blurb" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "buzzwords" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "recommended_tracks" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "fcc" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "status" "wxyc_schema"."review_status" DEFAULT 'submitted' NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "publish_website" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "publish_apps" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "publish_instagram" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD COLUMN "credit" "wxyc_schema"."review_credit";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD CONSTRAINT "reviews_intake_item_id_intake_items_id_fk" FOREIGN KEY ("intake_item_id") REFERENCES "wxyc_schema"."intake_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD CONSTRAINT "reviews_author_user_id_auth_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD CONSTRAINT "reviews_recorded_by_user_id_auth_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_album_id_idx" ON "wxyc_schema"."reviews" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX "reviews_intake_item_id_idx" ON "wxyc_schema"."reviews" USING btree ("intake_item_id");--> statement-breakpoint
CREATE INDEX "reviews_author_user_id_idx" ON "wxyc_schema"."reviews" USING btree ("author_user_id");--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" ADD CONSTRAINT "reviews_target_ck" CHECK ("wxyc_schema"."reviews"."album_id" IS NOT NULL OR "wxyc_schema"."reviews"."intake_item_id" IS NOT NULL);