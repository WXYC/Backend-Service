-- BS#2858 (slice 9b of BS#2791) -- the tables and columns behind accepting, versioning and printing a review and reporting an FCC note: `review_revisions`, `review_prints`, `fcc_notes`, and `intake_items.accepted_review_id` / `accepted_by` / `accepted_at`. No reader or writer in this migration; it lands the schema before anything can hold data so the catalog delete snapshot and restore can cover it from the first row.
--
-- Locks, all held until the shared migrate transaction commits, and each step finishes in well under a second because every table involved is small or new. The first ALTER TABLE on `intake_items` takes an AccessExclusiveLock on it, held until the shared migrate transaction commits, so every read and write of `intake_items` (every `/intake` route) waits from that statement until the commit, including while any later pending migration in the same transaction runs. The three new columns are nullable with no default, so the ADD COLUMNs rewrite no rows, but they still take that lock. The foreign key on `intake_items.accepted_review_id` validates by scanning `intake_items` under that AccessExclusiveLock and takes a SHARE ROW EXCLUSIVE lock on `reviews`; the index on that column is built in-migration, not CONCURRENTLY, since a migration runs inside a transaction. Each new table's foreign keys briefly take SHARE ROW EXCLUSIVE locks on `library`, `intake_items`, `reviews` and `auth_user`.
--
-- `reviews` and `intake_items` now reference each other (`reviews.intake_item_id` CASCADE, `intake_items.accepted_review_id` SET NULL). Both tables already exist, so the column and its foreign key are plain ALTERs and no deferred constraint is needed; deleting an item cascades to its reviews and the SET NULL then targets the row being deleted, which Postgres accepts.
--
-- @no-precondition-needed: the new tables are empty and the new `intake_items` columns are NULL on every existing row, so no CHECK or foreign key can be violated.
CREATE TYPE "wxyc_schema"."fcc_note_status" AS ENUM('reported', 'confirmed');--> statement-breakpoint
CREATE TABLE "wxyc_schema"."fcc_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer,
	"intake_item_id" integer,
	"track" text NOT NULL,
	"note" text NOT NULL,
	"status" "wxyc_schema"."fcc_note_status" DEFAULT 'reported' NOT NULL,
	"reported_by" varchar(128),
	"reported_by_user_id" varchar(255),
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_by" varchar(128),
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "fcc_notes_target_ck" CHECK ("wxyc_schema"."fcc_notes"."album_id" IS NOT NULL OR "wxyc_schema"."fcc_notes"."intake_item_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."review_prints" (
	"id" serial PRIMARY KEY NOT NULL,
	"intake_item_id" integer,
	"album_id" integer,
	"review_id" integer,
	"revision_id" integer,
	"printed_by" varchar(255),
	"printed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_prints_target_ck" CHECK ("wxyc_schema"."review_prints"."intake_item_id" IS NOT NULL OR "wxyc_schema"."review_prints"."album_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."review_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"review_id" integer NOT NULL,
	"revision" integer NOT NULL,
	"edited_by" varchar(128),
	"edited_by_user_id" varchar(255),
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review" text,
	"artist_blurb" text,
	"buzzwords" text,
	"recommended_tracks" text,
	"fcc" text,
	CONSTRAINT "review_revisions_review_id_revision_unique" UNIQUE("review_id","revision")
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD COLUMN "accepted_review_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD COLUMN "accepted_by" varchar(255);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."fcc_notes" ADD CONSTRAINT "fcc_notes_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."fcc_notes" ADD CONSTRAINT "fcc_notes_intake_item_id_intake_items_id_fk" FOREIGN KEY ("intake_item_id") REFERENCES "wxyc_schema"."intake_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."fcc_notes" ADD CONSTRAINT "fcc_notes_reported_by_user_id_auth_user_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."review_prints" ADD CONSTRAINT "review_prints_intake_item_id_intake_items_id_fk" FOREIGN KEY ("intake_item_id") REFERENCES "wxyc_schema"."intake_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."review_prints" ADD CONSTRAINT "review_prints_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."review_prints" ADD CONSTRAINT "review_prints_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "wxyc_schema"."reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."review_prints" ADD CONSTRAINT "review_prints_revision_id_review_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "wxyc_schema"."review_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."review_prints" ADD CONSTRAINT "review_prints_printed_by_auth_user_id_fk" FOREIGN KEY ("printed_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."review_revisions" ADD CONSTRAINT "review_revisions_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "wxyc_schema"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."review_revisions" ADD CONSTRAINT "review_revisions_edited_by_user_id_auth_user_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fcc_notes_album_id_idx" ON "wxyc_schema"."fcc_notes" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX "fcc_notes_intake_item_id_idx" ON "wxyc_schema"."fcc_notes" USING btree ("intake_item_id");--> statement-breakpoint
CREATE INDEX "review_prints_intake_item_id_idx" ON "wxyc_schema"."review_prints" USING btree ("intake_item_id");--> statement-breakpoint
CREATE INDEX "review_prints_album_id_idx" ON "wxyc_schema"."review_prints" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX "review_prints_review_id_idx" ON "wxyc_schema"."review_prints" USING btree ("review_id");--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_accepted_review_id_reviews_id_fk" FOREIGN KEY ("accepted_review_id") REFERENCES "wxyc_schema"."reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_accepted_by_auth_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_items_accepted_review_id_idx" ON "wxyc_schema"."intake_items" USING btree ("accepted_review_id");