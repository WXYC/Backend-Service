-- Flowsheet suggest indexes: support ghost text autocomplete prefix search.
--
-- Adds GIN trigram indexes on artist_name and track_title for ILIKE prefix
-- matching, and a btree index on entry_type for filtering to track entries.

CREATE INDEX "flowsheet_entry_type_idx" ON "wxyc_schema"."flowsheet" USING btree ("entry_type");--> statement-breakpoint
CREATE INDEX "flowsheet_artist_name_trgm_idx" ON "wxyc_schema"."flowsheet" USING gin ("artist_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "flowsheet_track_title_trgm_idx" ON "wxyc_schema"."flowsheet" USING gin ("track_title" gin_trgm_ops);
