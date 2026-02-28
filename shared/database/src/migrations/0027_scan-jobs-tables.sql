CREATE TYPE "wxyc_schema"."scan_job_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "wxyc_schema"."scan_result_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "wxyc_schema"."scan_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"status" "wxyc_schema"."scan_job_status" DEFAULT 'pending' NOT NULL,
	"total_items" smallint NOT NULL,
	"completed_items" smallint DEFAULT 0 NOT NULL,
	"failed_items" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."scan_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"item_index" smallint NOT NULL,
	"status" "wxyc_schema"."scan_result_status" DEFAULT 'pending' NOT NULL,
	"context" jsonb,
	"extraction" jsonb,
	"matched_album_id" integer,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."scan_jobs" ADD CONSTRAINT "scan_jobs_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."scan_results" ADD CONSTRAINT "scan_results_job_id_scan_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "wxyc_schema"."scan_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."scan_results" ADD CONSTRAINT "scan_results_matched_album_id_library_id_fk" FOREIGN KEY ("matched_album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scan_results_job_id_idx" ON "wxyc_schema"."scan_results" USING btree ("job_id");
