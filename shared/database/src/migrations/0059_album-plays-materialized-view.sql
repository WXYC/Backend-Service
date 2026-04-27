-- Materialized view that aggregates `flowsheet` track entries into per-album
-- play counts. Used by the new tsvector-based catalog search ranker
-- (`Both` mode) as the play-weight signal that nudges canonical answers to
-- the top of result lists.
--
-- The MV exists because the alternatives are worse:
--   * Reading `count(*)` over `flowsheet` at query time would push every
--     `/library` search through a full aggregation of 2.6M rows.
--   * Storing a play counter on `library` and incrementing on insert would
--     drift from the source of truth (flowsheet rows can be edited or
--     deleted, ETLs reload, etc.).
-- A materialized view re-derived from flowsheet on a schedule keeps the
-- read path O(1) and the value reproducible.
--
-- Refresh is owned by `apps/backend/services/album-plays-refresh.service.ts`
-- and tracked in the existing `cronjob_runs` table under job_name
-- 'album-plays-refresh'. Measured refresh on the staging clone (2.6M
-- flowsheet rows) is ~98ms, so a 1-hour cadence is comfortably idle.
--
-- The unique index on `album_id` is required by `REFRESH MATERIALIZED VIEW
-- CONCURRENTLY` — without it Postgres would block reads during refresh,
-- which defeats the purpose of an incremental signal for an interactive
-- search endpoint.

CREATE MATERIALIZED VIEW "wxyc_schema"."album_plays" AS
SELECT
    "album_id",
    count(*)::int AS "plays"
FROM "wxyc_schema"."flowsheet"
WHERE "entry_type" = 'track' AND "album_id" IS NOT NULL
GROUP BY "album_id";
--> statement-breakpoint

CREATE UNIQUE INDEX "album_plays_album_id_idx" ON "wxyc_schema"."album_plays" ("album_id");
