-- Flowsheet search indexes: support playlist archive search on album_title and record_label.
-- Complements the existing GIN trigram indexes on artist_name and track_title (0042),
-- so that "all fields" ILIKE searches can use BitmapOr across all four columns.

CREATE INDEX "flowsheet_album_title_trgm_idx" ON "wxyc_schema"."flowsheet" USING gin ("album_title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "flowsheet_record_label_trgm_idx" ON "wxyc_schema"."flowsheet" USING gin ("record_label" gin_trgm_ops);
