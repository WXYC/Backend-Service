-- 0156 uncovered-release search markers: uncovered_release_search_markers
-- (jobs/uncovered-release-list, BS#1877, ADR 0013's "uncovered-release
-- list handoff").
--
-- "Searched, found nothing" marker: one row per library.id that has EVER
-- been included in a published uncovered-releases.jsonl snapshot handed off
-- to WXYC/research-data, written at handoff time (not after a search result
-- comes back). Deliberately a dedicated table rather than a source_key
-- convention on album_critic_reviews (ADR 0013's other named option) --
-- see the schema.ts doc comment on uncovered_release_search_markers for the
-- full rationale. Creates a fresh table + FK + UNIQUE index against no
-- existing table, no rows rewritten (DDL-only).
--
-- Renumbered from 0146 to 0156 when this branch was rebased: main landed its
-- own 0146 (library-delete-denylist) in the interim. The DDL is byte-identical
-- to what 0146 carried; only the number and this note changed.
-- @no-precondition-needed: fresh empty table, no existing rows can violate the FK or UNIQUE index
CREATE TABLE "wxyc_schema"."uncovered_release_search_markers" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer NOT NULL,
	"first_handed_off_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_handed_off_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handoff_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."uncovered_release_search_markers" ADD CONSTRAINT "uncovered_release_search_markers_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uncovered_release_search_markers_album_id_uq" ON "wxyc_schema"."uncovered_release_search_markers" USING btree ("album_id");