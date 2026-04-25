-- DJ-name search indexes: support `dj:` filter and dj-name `all` matches.
-- Adds GIN trigram indexes on the three columns the search service ORs
-- together when filtering by DJ name, so the planner can BitmapOr across
-- them instead of falling back to a sequential scan over the join.
--
-- The COALESCE expression in the SELECT (DJ_NAME_EXPR) is unchanged — it
-- still produces the priority-ordered display name. Only the WHERE clause
-- filter is OR-decomposed across the underlying columns; see
-- apps/backend/services/search.service.ts buildDjNameMatch.

CREATE INDEX "auth_user_dj_name_trgm_idx"
  ON "auth_user" USING gin ("dj_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "auth_user_name_trgm_idx"
  ON "auth_user" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "shows_legacy_dj_name_trgm_idx"
  ON "wxyc_schema"."shows" USING gin ("legacy_dj_name" gin_trgm_ops);
