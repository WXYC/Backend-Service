-- Trigram fuzzy-match linkage for the B-2.2 flowsheet → library backfill.
-- Catches flowsheet rows whose normalized text *almost* matches a library
-- row but isn't an exact equi-join hit. Designed to run after both
-- direct-link-flowsheet.sql and discogs-bridge-flowsheet.sql, against the
-- residual neither could resolve.
--
-- Why this exists:
--   The exact-match passes leave a long tail of typos, missing words,
--   year/volume suffixes, and "Live"/"Best of" prefixes. Most of those
--   really do refer to a library row that already exists; pg_trgm's
--   trigram similarity catches them with high precision when the artist
--   side is held tight.
--
-- Normalization (Strategy 3; same as discogs-bridge-flowsheet.sql):
--   regexp_replace(regexp_replace(lower(f_unaccent(text)),
--                                 '^the\s+', '', 'i'),
--                  '[^a-z0-9 ]+', '', 'gi')
-- Requires the unaccent + pg_trgm extensions on the matching DB. Both live
-- on the local discogs-cache PG; prod has only pg_trgm, so the matching
-- runs locally and only the resulting stamps go to prod.
--
-- Thresholds:
--   similarity(artist_norm, library.artist_norm) >= 0.85
--   similarity(album_norm,  library.album_norm)  >= 0.70
-- The artist threshold is intentionally tight because this stage's job is
-- to be *precise* at the artist level — a wrong artist link is much more
-- visible than a wrong-edition link. The album threshold sits where the
-- spot-check turned up no false positives at the sample size used in the
-- 2026-04-28 run (year/volume suffixes, "Live"/"Best of" prefixes, single
-- typos all sit between 0.70 and 0.80; below 0.70 starts admitting
-- substring collisions).
--
-- Tie-break for ambiguous library candidates:
--   - 1 library candidate → accept.
--   - >1 candidates that all share the same canonical_entity_id stamp
--     (i.e. format variants of the same release) → accept the lowest id.
--   - >1 candidates with no shared canonical → reject.
--
-- Confidence: 0.85.
--
-- Idempotent: WHERE f.album_id IS NULL guard. The first prod run linked
-- 61,122 rows on 2026-04-28.
--
-- Reversible:
--   UPDATE wxyc_schema.flowsheet
--   SET album_id = NULL,
--       linkage_source = NULL,
--       linkage_confidence = NULL,
--       linked_at = NULL
--   WHERE linkage_source = 'fuzzy_trigram_match';
--
-- Run procedure (three stages — share STAGE 1 with discogs-bridge):
--
--   STAGE 1: pull raw flowsheet pairs and library rows from prod (see
--   discogs-bridge-flowsheet.sql for the export commands; this strategy
--   needs the same flowsheet-raw-pairs.csv plus a library-raw.csv with
--   (id, artist_name, album_title)).
--
--     ./scripts/query-flowsheet.sh --sql "
--       COPY (
--         SELECT l.id, a.artist_name, l.album_title
--         FROM wxyc_schema.library l
--         LEFT JOIN wxyc_schema.artists a ON a.id = l.artist_id
--       ) TO STDOUT WITH (FORMAT CSV, HEADER true);
--     " | grep -v '^SET$' > /tmp/library-raw.csv
--
--   STAGE 2: match against the local Discogs cache PG (we reuse it because
--   it already has unaccent + pg_trgm + the trigram-friendly libraries).
--   The SQL below produces /tmp/fuzzy-trigram-stamps.csv on the container.
--   STAGE 1's flowsheet_raw + library_stamps tables from
--   discogs-bridge-flowsheet.sql are reused if both strategies are run in
--   the same session; otherwise re-create them with the same DDL.
--
--     docker cp /tmp/library-raw.csv discogs-cache-db-1:/tmp/
--     docker exec -i discogs-cache-db-1 psql -U discogs -d discogs \
--       -f /path/to/this/file
--     docker cp discogs-cache-db-1:/tmp/fuzzy-trigram-stamps.csv /tmp/
--
--   STAGE 3: apply on prod via build-flowsheet-stamps-sql.py (see
--   discogs-bridge-flowsheet.sql for the full invocation; the only changes
--   are --linkage-source fuzzy_trigram_match and --confidence 0.85).
--
--     python3 scripts/build-flowsheet-stamps-sql.py \
--       --csv /tmp/fuzzy-trigram-stamps.csv \
--       --linkage-source fuzzy_trigram_match \
--       --confidence 0.85 \
--       > /tmp/fuzzy-trigram-update.sql

-- ============================================================================
-- STAGE 2: local matching SQL (runs on discogs-cache, NOT on prod RDS).
-- Assumes flowsheet_raw + library_stamps already exist (from
-- discogs-bridge-flowsheet.sql). If they don't, recreate them with the
-- DDL+\COPY blocks from that file before running this one.
-- ============================================================================

\set ON_ERROR_STOP on
SET statement_timeout = '0';
SET pg_trgm.similarity_threshold = 0.6;  -- prefilter for the GIN scan

-- Library raw → normalized + trigram-indexed.
DROP TABLE IF EXISTS public.library_raw;
DROP TABLE IF EXISTS public.library_norm;
CREATE TABLE public.library_raw (id INT, artist_name TEXT, album_title TEXT);
\COPY public.library_raw FROM '/tmp/library-raw.csv' WITH (FORMAT CSV, HEADER true);

CREATE TABLE public.library_norm AS
SELECT
  id,
  regexp_replace(regexp_replace(lower(f_unaccent(coalesce(artist_name, ''))), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi') AS artist_norm,
  regexp_replace(regexp_replace(lower(f_unaccent(coalesce(album_title, ''))), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi') AS album_norm
FROM public.library_raw;
CREATE INDEX library_norm_artist_trgm ON public.library_norm USING gin (artist_norm gin_trgm_ops);
CREATE INDEX library_norm_album_trgm  ON public.library_norm USING gin (album_norm  gin_trgm_ops);

-- Flowsheet residual: drop pairs already stamped by direct-link or
-- discogs-bridge so we only fuzzy against the leftover. If you skipped
-- those passes, point this at flowsheet_pairs directly.
DROP TABLE IF EXISTS public.flowsheet_residual;
CREATE TABLE public.flowsheet_residual AS
SELECT artist_norm, album_norm, row_count
FROM public.flowsheet_pairs
WHERE length(trim(artist_norm)) >= 2
  AND length(trim(album_norm))  >= 2;
CREATE INDEX flowsheet_residual_artist_trgm ON public.flowsheet_residual USING gin (artist_norm gin_trgm_ops);
CREATE INDEX flowsheet_residual_album_trgm  ON public.flowsheet_residual USING gin (album_norm  gin_trgm_ops);

-- All trigram hits above the per-side thresholds.
DROP TABLE IF EXISTS public.fuzzy_full;
CREATE TABLE public.fuzzy_full AS
SELECT
  fr.artist_norm,
  fr.album_norm,
  ln.id AS library_id,
  similarity(fr.artist_norm, ln.artist_norm)
    + similarity(fr.album_norm, ln.album_norm) AS combined
FROM public.flowsheet_residual fr
JOIN public.library_norm ln
  ON fr.artist_norm % ln.artist_norm
 AND fr.album_norm  % ln.album_norm
WHERE similarity(fr.artist_norm, ln.artist_norm) >= 0.85
  AND similarity(fr.album_norm,  ln.album_norm)  >= 0.70;
CREATE INDEX fuzzy_full_idx ON public.fuzzy_full (artist_norm, album_norm);

-- Resolve each pair to a single library_id, applying the canonical-stamp
-- tie-break for ambiguous candidates.
DROP TABLE IF EXISTS public.fuzzy_resolved;
CREATE TABLE public.fuzzy_resolved AS
WITH per_pair AS (
  SELECT
    artist_norm,
    album_norm,
    array_agg(library_id ORDER BY combined DESC, library_id) AS lib_ids,
    count(DISTINCT library_id) AS n_libs
  FROM public.fuzzy_full
  GROUP BY 1, 2
),
canonical_lookup AS (
  SELECT pp.artist_norm, pp.album_norm,
    count(DISTINCT ls.canonical_entity_id) AS distinct_canonicals,
    count(DISTINCT lib_id) AS lib_with_canonical
  FROM per_pair pp,
       unnest(pp.lib_ids) AS lib_id
  LEFT JOIN public.library_stamps ls ON ls.library_id = lib_id
  GROUP BY 1, 2
)
SELECT
  pp.artist_norm,
  pp.album_norm,
  CASE
    WHEN pp.n_libs = 1 THEN pp.lib_ids[1]
    WHEN cl.distinct_canonicals = 1
     AND cl.lib_with_canonical = pp.n_libs THEN pp.lib_ids[1]
    ELSE NULL
  END AS resolved_library_id
FROM per_pair pp
LEFT JOIN canonical_lookup cl USING (artist_norm, album_norm);

-- Expand to raw (artist_name, album_title) variants so the prod UPDATE can
-- equi-join without unaccent.
\COPY (
  SELECT fr.artist_name, fr.album_title, fres.resolved_library_id AS library_id
  FROM public.flowsheet_raw fr
  CROSS JOIN LATERAL (
    SELECT
      regexp_replace(regexp_replace(lower(f_unaccent(coalesce(fr.artist_name, ''))), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi') AS artist_norm,
      regexp_replace(regexp_replace(lower(f_unaccent(coalesce(fr.album_title, ''))), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi') AS album_norm
  ) n
  JOIN public.fuzzy_resolved fres USING (artist_norm, album_norm)
  WHERE fres.resolved_library_id IS NOT NULL
  ORDER BY fres.resolved_library_id, fr.artist_name
) TO '/tmp/fuzzy-trigram-stamps.csv' WITH (FORMAT CSV, HEADER true);

-- ============================================================================
-- STAGE 3: prod-side UPDATE template (same shape as discogs-bridge-flowsheet
-- with linkage_source='fuzzy_trigram_match' and linkage_confidence=0.85).
-- See discogs-bridge-flowsheet.sql for the full template; here we only
-- record the linkage_source/confidence values that build-flowsheet-stamps-sql.py
-- emits for this strategy.
-- ============================================================================
