-- @no-precondition-needed: empty-table FKs cannot be violated at apply time. The two ALTER TABLE ADD CONSTRAINT FOREIGN KEY statements below reference `wxyc_schema.library`(id), but the substrate tables are created empty in this same migration so there are zero rows to violate the FK invariant. Future migrations that ADD CONSTRAINT to populated `library_identity*` tables MUST include the §3.2.3 precondition guard inlining `truly_unresolved_rows < 1000` from `scripts/check-library-identity-gate.sql` (enforced by `scripts/check-precondition-guards.sh`).

-- 0075 cross-cache-identity substrate: empty `library_identity` +
-- `library_identity_source` + `library_identity_history` per plan §3.2.
--
-- All three tables are empty initially. No reader or writer code references
-- them in this PR — the dual-table writer (§3.2.2.2), the canonical-entity-id
-- backfill refactor (§4 step 2), and the manual-override MVP job (§3.2.4)
-- ship in subsequent PRs under epic E2-BS (#663). Behind feature flag
-- `BS_USE_LIBRARY_IDENTITY=false` (default; documented in CLAUDE.md
-- "Cross-cache-identity feature flags (canonical inventory)").
--
-- Operational notes:
--   - DDL only; AccessExclusiveLock acquired briefly per CREATE TABLE in a
--     single transaction. Tables are empty so the lock window is fast.
--   - Backfill is NOT in this migration (per CLAUDE.md "Migrations are
--     DDL-only"). The §4 step 2 backfill ships as a one-shot job under
--     `jobs/library-canonical-entity-backfill/` (refactored existing job).
--   - The `library_identity_audit_idx` on (confidence, distinct_unresolved_sources DESC)
--     is built inline because the table is empty; no `CONCURRENTLY` needed.
--
-- Plan reference: plans/library-hook-canonicalization-plan.md §3.2 (schema),
-- §3.2.3 (precondition guards + four-artifact checklist), §4.2 (feature flag).
-- Companion gate-check script: scripts/check-library-identity-gate.sql.
-- Companion CI linter: scripts/check-precondition-guards.sh.

CREATE TABLE "wxyc_schema"."library_identity" (
	"library_id" integer PRIMARY KEY NOT NULL,
	"discogs_master_id" integer,
	"discogs_release_id" integer,
	"musicbrainz_release_group_mbid" uuid,
	"musicbrainz_release_mbid" uuid,
	"musicbrainz_recording_mbid" uuid,
	"wikidata_qid" text,
	"spotify_id" text,
	"apple_music_id" text,
	"last_verified_at" timestamp with time zone NOT NULL,
	"method" text NOT NULL,
	"confidence" real NOT NULL,
	"agreement_sources" text,
	"notes" text,
	"distinct_unresolved_sources" integer GENERATED ALWAYS AS ((
        (CASE WHEN "discogs_master_id" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "discogs_release_id" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "musicbrainz_release_group_mbid" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "musicbrainz_release_mbid" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "musicbrainz_recording_mbid" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "wikidata_qid" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "spotify_id" IS NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "apple_music_id" IS NULL THEN 1 ELSE 0 END)
      )) STORED,
	CONSTRAINT "library_identity_confidence_range" CHECK ("wxyc_schema"."library_identity"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."library_identity_history" (
	"history_id" serial PRIMARY KEY NOT NULL,
	"library_id" integer NOT NULL,
	"discogs_master_id" integer,
	"discogs_release_id" integer,
	"musicbrainz_release_group_mbid" uuid,
	"musicbrainz_release_mbid" uuid,
	"musicbrainz_recording_mbid" uuid,
	"wikidata_qid" text,
	"spotify_id" text,
	"apple_music_id" text,
	"last_verified_at" timestamp with time zone,
	"method" text,
	"confidence" real,
	"agreement_sources" text,
	"notes" text,
	"superseded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_reason" text NOT NULL,
	"reason_category" text,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."library_identity_source" (
	"library_id" integer NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"method" text NOT NULL,
	"confidence" real NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	"boost_sources" text,
	"notes" text,
	CONSTRAINT "library_identity_source_library_id_source_pk" PRIMARY KEY("library_id","source"),
	CONSTRAINT "library_identity_source_confidence_range" CHECK ("wxyc_schema"."library_identity_source"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library_identity" ADD CONSTRAINT "library_identity_library_id_library_id_fk" FOREIGN KEY ("library_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library_identity_source" ADD CONSTRAINT "library_identity_source_library_id_library_id_fk" FOREIGN KEY ("library_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_identity_audit_idx" ON "wxyc_schema"."library_identity" USING btree ("confidence","distinct_unresolved_sources" DESC);