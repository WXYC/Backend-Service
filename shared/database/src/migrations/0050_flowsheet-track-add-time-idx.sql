-- Flowsheet recent-tracks index: support ORDER BY add_time DESC LIMIT N on
-- track entries. Without it the planner has no index that satisfies the
-- default sort, so every search query falls back to an in-memory sort over
-- the trigram bitmap output.
--
-- Partial WHERE entry_type = 'track' keeps the index small by excluding
-- break / message rows that the search filters out anyway, and matches the
-- exact predicate in apps/backend/services/search.service.ts.

CREATE INDEX "flowsheet_track_add_time_idx"
  ON "wxyc_schema"."flowsheet" USING btree ("add_time" DESC)
  WHERE "entry_type" = 'track';
