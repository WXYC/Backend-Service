-- 0126 tribute-context FK repair: detach fabricated headliner identities
-- from tribute-billed concerts.
--
-- A tribute-framed billing names the HONOREE, not the performer. The
-- upstream triangle-shows extractor mishandled honoree-first titles
-- ("REM Tribute to Lifes Rich Pageant" → headliner "REM") and the
-- resolver's alias arm then FK'd the real R.E.M. onto the Stanczyks
-- tribute show — which the station-affinity tier promoted into the iOS
-- On Tour "For You" shelf. Both resolver lanes now exclude
-- tribute-context rows outright (jobs/concerts-artist-resolver/query.ts,
-- jobs/concerts-artist-lml-resolver/targets.ts, this deploy); this
-- migration repairs the rows resolved before the guard existed.
--
-- Predicate over literal id on purpose: it is the same tribute-context
-- class the guards use (word-start \m so "Tributaries" never matches,
-- case-insensitive ~*, NULL-safe title arm via NULL-propagating OR), so
-- it repairs whatever each environment mis-resolved rather than assuming
-- prod's row ids. Scope verified in prod 2026-07-20 with the SELECT form
-- of this WHERE: 432 upcoming concerts, 12 tribute-context, exactly ONE
-- carried a resolved identity (id 4062 → artists.id 10047, R.E.M.).
--
-- Sequencing: this ships in the SAME deploy that adds the resolver
-- guards. The SQL lane is write-once (WHERE headlining_artist_id IS
-- NULL), so a bare NULL would otherwise re-enter the candidate pool and
-- be re-stamped at the next 05:15 UTC run; with the guard live first,
-- the NULLed row is permanently outside both lanes' candidate sets.
--
-- Enrichment side tables (artist_station_plays, artist_similar_artists)
-- key on artists.id, not the concert, so detaching the FK fully removes
-- the concert from the curated feed; their rows for the artist stay
-- (UPSERT-only writers, harmless when no concert joins them).
--
-- Lock behavior: single UPDATE touching ~1 row — row locks only, no
-- table rewrite, no index rebuild.
-- @no-analyze-needed: repairs a single known row per environment; stats drift immaterial
UPDATE "wxyc_schema"."concerts"
SET "headlining_artist_id" = NULL,
    "headlining_discogs_artist_id" = NULL,
    "headlining_discogs_artist_id_source" = NULL
WHERE ("title" ~* '\mtribute' OR "headlining_artist_raw" ~* '\mtribute')
  AND ("headlining_artist_id" IS NOT NULL OR "headlining_discogs_artist_id" IS NOT NULL);
