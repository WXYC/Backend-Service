-- BS#2794 (slice 5 of BS#2791) -- `intake_items` and `intake_item_passes`: records that have arrived and are waiting for a DJ review, and the DJs who declined them.
--
-- Additive and DDL-only: both tables are new and empty. `intake_items` carries two FKs into `library` with different delete rules: `album_id` CASCADEs, `cited_album_id` SETs NULL. Every `auth_user` reference SETs NULL except `intake_item_passes.dj_id`, which CASCADEs.
--
-- @no-precondition-needed: every constraint is added in the same migration that creates its (empty) table, so no existing row can violate it.
CREATE TYPE "wxyc_schema"."intake_item_state" AS ENUM('pool', 'requested', 'checked_out', 'reviewed', 'filed', 'finalized');--> statement-breakpoint
CREATE TABLE "wxyc_schema"."intake_item_passes" (
	"id" serial PRIMARY KEY NOT NULL,
	"intake_item_id" integer NOT NULL,
	"dj_id" varchar(255) NOT NULL,
	"passed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."intake_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"artist_name" varchar(128) NOT NULL,
	"album_title" varchar(128) NOT NULL,
	"record_label" varchar(128),
	"label_id" integer,
	"format_id" integer NOT NULL,
	"discogs_release_id" integer,
	"state" "wxyc_schema"."intake_item_state" DEFAULT 'pool' NOT NULL,
	"logged_by" varchar(255),
	"logged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_dj_id" varchar(255),
	"requested_at" timestamp with time zone,
	"checked_out_by" varchar(255),
	"checked_out_at" timestamp with time zone,
	"cited_album_id" integer,
	"cited_submission_id" integer,
	"album_id" integer,
	"filed_by" varchar(255),
	"filed_at" timestamp with time zone,
	"rotation_id" integer,
	"printed_by" varchar(255),
	"printed_at" timestamp with time zone,
	"finalized_by" varchar(255),
	"finalized_at" timestamp with time zone,
	CONSTRAINT "intake_items_citation_exclusive_ck" CHECK ("wxyc_schema"."intake_items"."cited_album_id" IS NULL OR "wxyc_schema"."intake_items"."cited_submission_id" IS NULL),
	CONSTRAINT "intake_items_filed_requires_album_ck" CHECK ("wxyc_schema"."intake_items"."state" NOT IN ('filed', 'finalized') OR "wxyc_schema"."intake_items"."album_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_item_passes" ADD CONSTRAINT "intake_item_passes_intake_item_id_intake_items_id_fk" FOREIGN KEY ("intake_item_id") REFERENCES "wxyc_schema"."intake_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_item_passes" ADD CONSTRAINT "intake_item_passes_dj_id_auth_user_id_fk" FOREIGN KEY ("dj_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "wxyc_schema"."labels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_format_id_format_id_fk" FOREIGN KEY ("format_id") REFERENCES "wxyc_schema"."format"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_logged_by_auth_user_id_fk" FOREIGN KEY ("logged_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_requested_dj_id_auth_user_id_fk" FOREIGN KEY ("requested_dj_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_checked_out_by_auth_user_id_fk" FOREIGN KEY ("checked_out_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_cited_album_id_library_id_fk" FOREIGN KEY ("cited_album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_cited_submission_id_album_review_submissions_id_fk" FOREIGN KEY ("cited_submission_id") REFERENCES "wxyc_schema"."album_review_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_filed_by_auth_user_id_fk" FOREIGN KEY ("filed_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_rotation_id_rotation_id_fk" FOREIGN KEY ("rotation_id") REFERENCES "wxyc_schema"."rotation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_printed_by_auth_user_id_fk" FOREIGN KEY ("printed_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD CONSTRAINT "intake_items_finalized_by_auth_user_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_item_passes_intake_item_id_idx" ON "wxyc_schema"."intake_item_passes" USING btree ("intake_item_id");--> statement-breakpoint
CREATE INDEX "intake_items_state_idx" ON "wxyc_schema"."intake_items" USING btree ("state");--> statement-breakpoint
CREATE INDEX "intake_items_album_id_idx" ON "wxyc_schema"."intake_items" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX "intake_items_cited_album_id_idx" ON "wxyc_schema"."intake_items" USING btree ("cited_album_id");--> statement-breakpoint
CREATE INDEX "intake_items_requested_dj_id_idx" ON "wxyc_schema"."intake_items" USING btree ("requested_dj_id");--> statement-breakpoint
CREATE INDEX "intake_items_checked_out_by_idx" ON "wxyc_schema"."intake_items" USING btree ("checked_out_by");