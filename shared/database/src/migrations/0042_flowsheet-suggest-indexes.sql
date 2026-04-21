-- Flowsheet suggest indexes: support ghost text autocomplete prefix search.
-- Adds GIN trigram indexes on artist_name and track_title for ILIKE prefix matching.

CREATE INDEX "flowsheet_artist_name_trgm_idx" ON "wxyc_schema"."flowsheet" USING gin ("artist_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "flowsheet_track_title_trgm_idx" ON "wxyc_schema"."flowsheet" USING gin ("track_title" gin_trgm_ops);
