-- Add reconciled canonical-entity linkage columns to library (Epic B.1).
-- B-0 (issue #492) confirmed LML doesn't expose per-result confidence, so the
-- value stored here is heuristic-derived (search_type=direct => high; fallback
-- => low) at link time and kept around for retroactive re-judging once LML
-- exposes a real signal.
--
-- Column choices:
--   canonical_entity_id          TEXT  — opaque identifier (Discogs/MusicBrainz/
--                                        LML id, optionally namespaced). The
--                                        scheme is the resolver's contract, not
--                                        this column's; TEXT keeps us flexible
--                                        if the source-of-truth shifts.
--   canonical_entity_confidence  REAL  — confidence at link time, in [0, 1].
--   canonical_entity_resolved_at TIMESTAMPTZ — when the linkage was set, for
--                                        audit + retry policy.
--
-- Index: B-tree on canonical_entity_id supports the flowsheet → library join
-- via canonical entity (B-2). Default B-tree (not GIN/hash) — we want range
-- and equality lookups, the column is short text, and the cardinality is at
-- most one row per ~64K library entries.
--
-- Order across Epic B:
--   B-1.1 (this migration): add nullable columns + index.
--   B-1.2 (backfill job):   populate from LML for existing rows.
--   B-1.3 (live writes):    addAlbum writes the linkage on insert.
--   B-1.4 (flowsheet):      add audit columns on the flowsheet side.
--
-- Production note: ALTER TABLE ADD COLUMN of nullable columns is metadata-
-- only, so this DDL is fast even on the full library. CREATE INDEX takes a
-- ShareLock that blocks writes; on ~64K rows this completes in well under a
-- second. No CONCURRENTLY needed (and CONCURRENTLY can't run inside a
-- migration transaction anyway).

ALTER TABLE "wxyc_schema"."library"
  ADD COLUMN "canonical_entity_id" text;--> statement-breakpoint

ALTER TABLE "wxyc_schema"."library"
  ADD COLUMN "canonical_entity_confidence" real;--> statement-breakpoint

ALTER TABLE "wxyc_schema"."library"
  ADD COLUMN "canonical_entity_resolved_at" timestamp with time zone;--> statement-breakpoint

CREATE INDEX "library_canonical_entity_id_idx"
  ON "wxyc_schema"."library" ("canonical_entity_id");
