-- Flowsheet hybrid search: generated tsvector covering the four text fields
-- with weight bands (artist=A, track=B, album=C, label=D), backed by a GIN
-- index. The search service routes 'all'-field queries between this tsvector
-- path and the existing trigram path based on query shape; field-prefixed
-- queries (artist:, song:, album:, label:) keep using trigram.
--
-- Uses the 'simple' text search config — music titles are full of proper
-- nouns, foreign words, and stylized spellings that English stemming
-- distorts; 'simple' tokenizes on word boundaries without stemming or
-- stop-word removal.

ALTER TABLE "wxyc_schema"."flowsheet"
  ADD COLUMN "search_doc" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("artist_name", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("track_title", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("album_title", '')), 'C') ||
    setweight(to_tsvector('simple', coalesce("record_label", '')), 'D')
  ) STORED;--> statement-breakpoint

CREATE INDEX "flowsheet_search_doc_idx"
  ON "wxyc_schema"."flowsheet" USING gin ("search_doc");
