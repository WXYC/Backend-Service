-- Manual review queue for gray-zone LML matches (B-3.1, issue #501).
--
-- Holds one row per flowsheet entry whose LML lookup produced something but
-- not a direct hit (search_type='fallback' under B-0's calibration). The
-- B-2.2 backfill enqueues these instead of guessing; an operator drains the
-- queue with `npx tsx scripts/review-linkage.ts`. On accept, the CLI stamps
-- `flowsheet.album_id` + `linkage_source='human_review'` and marks the queue
-- row reviewed.
--
-- Column choices:
--   flowsheet_id           — UNIQUE so re-running the backfill is a no-op
--                            (insert ... on conflict do nothing). Cascades on
--                            delete because the queue row is meaningless once
--                            the flowsheet entry is gone.
--   candidate_library_ids  — INTEGER[] of WXYC library rows resolved from
--                            LML's ranked results via canonical_entity_id.
--                            Order matches LML's ranking; the CLI presents
--                            them in that order. Empty array allowed when
--                            LML returned results we couldn't match against
--                            the local library — those still warrant
--                            human eyeballs because the artist text may
--                            need correction before another sweep.
--   candidate_confidences  — REAL[] aligned with candidate_library_ids.
--                            Sourced from LML's per-result signal; for
--                            fallback hits LML doesn't expose a number
--                            today (tracked at WXYC/library-metadata-lookup#158)
--                            so the resolver synths a single value per
--                            search_type. Kept as an array so the CLI can
--                            display per-candidate scores when LML grows them.
--   suggested_action       — Free-form text identifying which heuristic
--                            sent this row to review (currently only
--                            'review_fallback'). Lets future heuristics
--                            (e.g., low-numeric-confidence direct hits once
--                            LML exposes a score) land on the same queue
--                            without a schema change.
--   created_at             — When the backfill enqueued this row.
--   reviewed_at            — When the CLI resolved it. NULL until then.
--   reviewed_decision      — 'accepted' | 'rejected' | 'skipped'. NULL while
--                            unreviewed; set together with reviewed_at.
--
-- Index: partial B-tree on (created_at) WHERE reviewed_at IS NULL keeps the
-- "next case to review" query bounded to the unreviewed slice. Unreviewed
-- rows are the only ones the CLI ever scans; reviewed ones are kept for
-- audit and never queried hot.
--
-- Production note: empty CREATE TABLE acquires a brief AccessExclusiveLock
-- but holds no data, so this is fast on any DB. Index creation on an empty
-- table is instant.

-- @no-precondition-needed: brand-new CREATE TABLE. The UNIQUE on
-- flowsheet_id, the NOT NULL columns, and the FK to flowsheet(id) are all
-- evaluated against zero rows at apply time — no existing data can violate
-- them. Subsequent inserts are bounded by the constraints themselves.

CREATE TABLE "wxyc_schema"."flowsheet_linkage_review" (
  "id" serial PRIMARY KEY,
  "flowsheet_id" integer NOT NULL UNIQUE
    REFERENCES "wxyc_schema"."flowsheet"("id") ON DELETE CASCADE,
  "candidate_library_ids" integer[] NOT NULL,
  "candidate_confidences" real[] NOT NULL,
  "suggested_action" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "reviewed_at" timestamp with time zone,
  "reviewed_decision" text
);--> statement-breakpoint

CREATE INDEX "flowsheet_linkage_review_unreviewed_idx"
  ON "wxyc_schema"."flowsheet_linkage_review" ("created_at")
  WHERE "reviewed_at" IS NULL;
