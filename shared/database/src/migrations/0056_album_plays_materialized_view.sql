CREATE MATERIALIZED VIEW "wxyc_schema"."album_plays" AS
SELECT album_id, count(*)::int AS plays
FROM "wxyc_schema"."flowsheet"
WHERE entry_type = 'track' AND album_id IS NOT NULL
GROUP BY album_id;
--> statement-breakpoint

CREATE UNIQUE INDEX "album_plays_album_id_idx" ON "wxyc_schema"."album_plays" ("album_id");
