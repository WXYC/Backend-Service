-- Discogs-bridge linkage for the B-2.2 flowsheet → library backfill.
-- Links unlinked flowsheet rows by going via the local Discogs snapshot:
--   flowsheet (artist, album) text  -- normalized -->  Discogs release/master
--   library.canonical_entity_id     ----- stamped -->  Discogs release/master
-- A flowsheet row gets stamped when both sides resolve to the same Discogs
-- entity, which means the bridge catches cases where flowsheet text differs
-- from library text (typo, transliteration, alternate edition) but both name
-- the same album in Discogs. Designed to run after direct-link-flowsheet.sql
-- and before fuzzy-trigram-flowsheet.sql.
--
-- Why this exists:
--   ~6.7% of unlinked flowsheet pairs match a Discogs entry locally, and a
--   subset of those bridge to a stamped library row even when the raw text
--   pair didn't match anything in direct-link's text-only pass. The prod RDS
--   has no Discogs data of its own, so the matching step runs against the
--   local discogs-cache PG (port 5433); only the resulting stamps are pushed
--   back to prod.
--
-- Normalization (Strategy 3; applied to both sides on the local cache):
--   regexp_replace(regexp_replace(lower(f_unaccent(text)),
--                                 '^the\s+', '', 'i'),
--                  '[^a-z0-9 ]+', '', 'gi')
-- f_unaccent requires the unaccent extension, which lives on the local
-- discogs-cache PG but NOT on prod RDS — that's why this strategy can't
-- run as a single prod query the way direct-link-flowsheet.sql does.
--
-- Confidence: 0.9. Bridges are accepted when:
--   1. The flowsheet pair resolves to a single Discogs entity (master_id
--      preferred; release_id fallback). Pairs with multiple distinct
--      Discogs entities are dropped.
--   2. That Discogs entity maps to exactly one library_id via
--      library.canonical_entity_id. If multiple library rows share the
--      stamp (format variants of the same release) we accept the lowest id;
--      that's a deliberate same-album tie-break consistent with how the
--      library backfill picks among aliases.
--
-- Idempotent: the WHERE f.album_id IS NULL guard means re-runs are no-ops.
-- The first prod run linked 13,548 rows on 2026-04-28.
--
-- Reversible:
--   UPDATE wxyc_schema.flowsheet
--   SET album_id = NULL,
--       linkage_source = NULL,
--       linkage_confidence = NULL,
--       linked_at = NULL
--   WHERE linkage_source = 'discogs_local_bridge';
--
-- Run procedure (three stages — review the dry-run before committing):
--
--   STAGE 1: pull inputs from prod (run from a workstation that can reach
--   prod RDS via scripts/query-flowsheet.sh and run docker locally).
--
--     # 1a. Unlinked flowsheet pairs (deduped raw text; we re-normalize
--     #     locally so we can use unaccent uniformly).
--     ./scripts/query-flowsheet.sh --sql "
--       COPY (
--         SELECT artist_name, album_title, count(*) AS row_count
--         FROM wxyc_schema.flowsheet
--         WHERE album_id IS NULL
--           AND entry_type='track'
--           AND artist_name IS NOT NULL
--           AND album_title IS NOT NULL
--           AND (legacy_release_id IS NULL OR legacy_link_attempted_at IS NOT NULL)
--         GROUP BY 1, 2
--       ) TO STDOUT WITH (FORMAT CSV, HEADER true);
--     " | grep -v '^SET$' > /tmp/flowsheet-raw-pairs.csv
--
--     # 1b. Library canonical_entity_id stamps (29K rows after B-1.2).
--     ./scripts/query-flowsheet.sh --sql "
--       COPY (
--         SELECT id, canonical_entity_id
--         FROM wxyc_schema.library
--         WHERE canonical_entity_id IS NOT NULL
--       ) TO STDOUT WITH (FORMAT CSV, HEADER false);
--     " | grep -v '^SET$' > /tmp/library-stamps.csv
--
--   STAGE 2: match against the local Discogs cache. The SQL below runs
--   inside the discogs-cache-db container (assumes wxyc.release +
--   wxyc.release_artist + unaccent extension are present from
--   discogs-etl). After it runs, /tmp/discogs-bridge-stamps.csv on the
--   container holds the (artist_name, album_title, library_id) tuples.
--
--     docker cp /tmp/flowsheet-raw-pairs.csv discogs-cache-db-1:/tmp/
--     docker cp /tmp/library-stamps.csv      discogs-cache-db-1:/tmp/
--     docker exec -i discogs-cache-db-1 psql -U discogs -d discogs \
--       -f /path/to/this/file
--     docker cp discogs-cache-db-1:/tmp/discogs-bridge-stamps.csv /tmp/
--
--   STAGE 3: apply on prod. scripts/build-flowsheet-stamps-sql.py converts
--   the stamps CSV into a single transactional UPDATE; we scp it to EC2 and
--   feed it to psql via docker mount because the resulting SQL is too large
--   for ssh's inline command buffer.
--
--     python3 scripts/build-flowsheet-stamps-sql.py \
--       --csv /tmp/discogs-bridge-stamps.csv \
--       --linkage-source discogs_local_bridge \
--       --confidence 0.9 \
--       > /tmp/discogs-bridge-update.sql
--     scp /tmp/discogs-bridge-update.sql wxyc-ec2:/tmp/
--     ssh wxyc-ec2 'docker run --rm -i \
--       -v /tmp/discogs-bridge-update.sql:/tmp/script.sql:ro \
--       -e PGPASSWORD="$DB_PASS" postgres:16-alpine \
--       psql -w "host=$DB_HOST user=$DB_USER dbname=$DB_NAME sslmode=require" \
--       -v ON_ERROR_STOP=1 -f /tmp/script.sql'
--
--   The build-flowsheet-stamps-sql.py output starts with ROLLBACK so the
--   first run is a dry-run; flip to COMMIT once the row count looks right.

-- ============================================================================
-- STAGE 2: local matching SQL (runs on discogs-cache, NOT on prod RDS).
-- ============================================================================

\set ON_ERROR_STOP on
SET statement_timeout = '0';

-- Inputs: the two CSVs copied into /tmp/ on the container.
DROP TABLE IF EXISTS public.flowsheet_raw;
DROP TABLE IF EXISTS public.library_stamps;
CREATE TABLE public.flowsheet_raw (artist_name TEXT, album_title TEXT, row_count INT);
CREATE TABLE public.library_stamps (library_id INT, canonical_entity_id TEXT);

\COPY public.flowsheet_raw FROM '/tmp/flowsheet-raw-pairs.csv' WITH (FORMAT CSV, HEADER true);
\COPY public.library_stamps FROM '/tmp/library-stamps.csv'    WITH (FORMAT CSV);

CREATE INDEX library_stamps_canonical_idx ON public.library_stamps (canonical_entity_id);

-- Re-aggregate on the unaccented, fully normalized form. Doing this locally
-- (rather than in the prod export) guarantees the same normalization on both
-- sides of the join — prod has no f_unaccent.
DROP TABLE IF EXISTS public.flowsheet_pairs;
CREATE TABLE public.flowsheet_pairs AS
SELECT
  regexp_replace(regexp_replace(lower(f_unaccent(coalesce(artist_name, ''))), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi') AS artist_norm,
  regexp_replace(regexp_replace(lower(f_unaccent(coalesce(album_title, ''))), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi') AS album_norm,
  sum(row_count) AS row_count
FROM public.flowsheet_raw
GROUP BY 1, 2;
CREATE INDEX flowsheet_pairs_idx ON public.flowsheet_pairs (artist_norm, album_norm);

-- (flowsheet pair) × Discogs match.
-- ra.extra = 0 keeps only primary artists on each release (skips "extra"
-- artist credits, which are always denoted as accompaniments rather than
-- the canonical credit).
DROP TABLE IF EXISTS public.flowsheet_match;
CREATE TABLE public.flowsheet_match AS
SELECT
  fp.artist_norm,
  fp.album_norm,
  count(DISTINCT coalesce(NULLIF(r.master_id, 0), -r.id)) AS distinct_entities,
  MIN(NULLIF(r.master_id, 0)) AS master_id,
  MIN(r.id) AS release_id
FROM public.flowsheet_pairs fp
JOIN wxyc.release_artist ra
  ON regexp_replace(regexp_replace(lower(f_unaccent(ra.artist_name)), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi') = fp.artist_norm
 AND ra.extra = 0
JOIN wxyc.release r
  ON r.id = ra.release_id
 AND regexp_replace(regexp_replace(lower(f_unaccent(r.title)), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi') = fp.album_norm
WHERE length(trim(fp.artist_norm)) > 0
  AND length(trim(fp.album_norm)) > 0
GROUP BY 1, 2;

-- Bridge: each (flowsheet pair, Discogs entity) checked against library
-- stamps preferring master, falling back to release. We drop pairs where
-- the Discogs side is ambiguous (multiple distinct entities) AND the
-- library side disagrees; if all candidates point to the same library_id
-- we accept that single library_id.
DROP TABLE IF EXISTS public.flowsheet_bridge_stamps;
CREATE TABLE public.flowsheet_bridge_stamps AS
WITH candidates AS (
  SELECT
    artist_norm,
    album_norm,
    'discogs:master:'  || master_id::text  AS master_cid,
    'discogs:release:' || release_id::text AS release_cid,
    master_id
  FROM public.flowsheet_match
),
via_master AS (
  SELECT c.artist_norm, c.album_norm, ls.library_id
  FROM candidates c
  JOIN public.library_stamps ls ON ls.canonical_entity_id = c.master_cid
  WHERE c.master_id IS NOT NULL
),
via_release AS (
  SELECT c.artist_norm, c.album_norm, ls.library_id
  FROM candidates c
  JOIN public.library_stamps ls ON ls.canonical_entity_id = c.release_cid
)
SELECT
  artist_norm,
  album_norm,
  MIN(library_id) AS library_id
FROM (SELECT * FROM via_master UNION ALL SELECT * FROM via_release) m
GROUP BY 1, 2
HAVING count(DISTINCT library_id) = 1;

-- Expand back to raw text variants so the prod-side UPDATE can join on
-- exact (artist_name, album_title) equality (prod has no unaccent).
\COPY (
  SELECT fr.artist_name, fr.album_title, fbs.library_id
  FROM public.flowsheet_raw fr
  CROSS JOIN LATERAL (
    SELECT
      regexp_replace(regexp_replace(lower(f_unaccent(coalesce(fr.artist_name, ''))), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi') AS artist_norm,
      regexp_replace(regexp_replace(lower(f_unaccent(coalesce(fr.album_title, ''))), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi') AS album_norm
  ) n
  JOIN public.flowsheet_bridge_stamps fbs USING (artist_norm, album_norm)
  ORDER BY fbs.library_id, fr.artist_name
) TO '/tmp/discogs-bridge-stamps.csv' WITH (FORMAT CSV, HEADER true);

-- ============================================================================
-- STAGE 3: prod-side UPDATE template.
--
-- The actual prod-side SQL is generated by build-flowsheet-stamps-sql.py
-- (which inlines the CSV as a VALUES clause). The shape it produces is:
--
--   SET statement_timeout = '600s';
--   BEGIN;
--   CREATE TEMP TABLE stamps (artist_name TEXT, album_title TEXT, library_id INT)
--     ON COMMIT DROP;
--   INSERT INTO stamps VALUES
--     ('Artist 1', 'Album 1', 12345),
--     ...;
--   UPDATE wxyc_schema.flowsheet f
--   SET album_id = s.library_id,
--       linkage_source = 'discogs_local_bridge',
--       linkage_confidence = 0.9,
--       linked_at = now()
--   FROM stamps s
--   WHERE f.artist_name = s.artist_name
--     AND f.album_title = s.album_title
--     AND f.album_id IS NULL
--     AND f.entry_type = 'track';
--   COMMIT;  -- (or ROLLBACK during the dry-run)
--
-- Notes:
--   - artist_name / album_title equality on raw text is intentional: prod
--     can't replicate the f_unaccent-based normalization, but the raw text
--     variants we exported above cover every spelling that appeared in the
--     unlinked residual.
--   - entry_type='track' guards against accidentally writing album_id onto
--     break/show-marker rows, which can't have a library link anyway.
-- ============================================================================
