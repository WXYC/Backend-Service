-- 0119 album_review_submissions (album-reviews-sheet-sync plan, ADR 0011)
--
-- Archive of the ~1,650 DJ-written album reviews collected since March 2021
-- in the "Album Review Responses" Google Form, mirrored nightly by
-- jobs/album-reviews-etl/. One row per form submission; identity is
-- free-text (artist_name/album_title verbatim), with album_id a best-effort
-- singleton-match link into `library` (ON DELETE SET NULL — a library
-- deletion must not take the submission with it).
--
-- Deliberately a SEPARATE table from `reviews`: ADR 0006 reserves `reviews`
-- as the one-per-album, author-owned, MD-queued in-app Review model. The
-- form archive is multi-per-album, free-text-authored, and immutable — see
-- docs/adr/0011-album-review-submissions-separate-archive.md.
--
-- source_key is the UPSERT natural key (form:<ISO UTC> of the parsed form
-- timestamp; nots:<norm_artist>:<norm_album>:<sha256[0:8](reviewer_raw)>
-- fallback for the rare timestamp-less row), partial-unique WHERE NOT NULL.
-- reviewer_raw / social_consent_raw are PII-internal (the form promised
-- "your name will not be shared") and are never emitted by the read
-- endpoint.
--
-- DDL-only; takes a brief AccessExclusiveLock on a table that does not yet
-- exist, so no live-traffic impact.
--
-- @no-precondition-needed: new table, no pre-existing rows — the FK and the
-- partial UNIQUE index constrain an empty relation, so they are provably
-- safe at apply time.
--
-- IF NOT EXISTS + CONCURRENTLY note: the table is brand-new (created empty
-- in this same migration), so the in-transaction index builds are instant —
-- but follow the established index runbook anyway so the migration stays a
-- no-op if an operator ever pre-builds out-of-band (no AccessExclusiveLock,
-- no INSERT pause):
--
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "album_review_submissions_source_key_uq"
--     ON "wxyc_schema"."album_review_submissions" USING btree ("source_key")
--     WHERE "wxyc_schema"."album_review_submissions"."source_key" IS NOT NULL;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "album_review_submissions_album_id_idx"
--     ON "wxyc_schema"."album_review_submissions" USING btree ("album_id");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "album_review_submissions_submitted_at_idx"
--     ON "wxyc_schema"."album_review_submissions" USING btree ("submitted_at");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "album_review_submissions_norm_artist_idx"
--     ON "wxyc_schema"."album_review_submissions" USING btree ("norm_artist");
--
-- The in-migration forms below are NOT CONCURRENTLY because Drizzle wraps
-- each migration in a transaction (CONCURRENTLY cannot run inside a transaction block);
-- IF NOT EXISTS makes them no-ops when a CONCURRENTLY build ran first,
-- while a fresh dev DB picks the indexes up on first migrate.

CREATE TABLE "wxyc_schema"."album_review_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer,
	"artist_name" text,
	"album_title" text,
	"record_label" text,
	"artist_blurb" text,
	"review" text,
	"recommended_tracks" text,
	"buzzwords" text,
	"fcc_violations" text,
	"review_purpose" text,
	"reviewer_raw" text,
	"social_consent_raw" text,
	"social_consent" boolean,
	"released_within_six_months" boolean,
	"rotated" boolean,
	"submitted_at" timestamp with time zone,
	"source" text DEFAULT 'google_form' NOT NULL,
	"source_key" text,
	"norm_artist" text,
	"norm_album" text,
	"add_date" date DEFAULT now() NOT NULL,
	"last_modified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_review_submissions" ADD CONSTRAINT "album_review_submissions_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "album_review_submissions_source_key_uq" ON "wxyc_schema"."album_review_submissions" USING btree ("source_key") WHERE "wxyc_schema"."album_review_submissions"."source_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "album_review_submissions_album_id_idx" ON "wxyc_schema"."album_review_submissions" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "album_review_submissions_submitted_at_idx" ON "wxyc_schema"."album_review_submissions" USING btree ("submitted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "album_review_submissions_norm_artist_idx" ON "wxyc_schema"."album_review_submissions" USING btree ("norm_artist");