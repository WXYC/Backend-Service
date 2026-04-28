-- Direct text-match pre-pass for the B-2.2 flowsheet → library linkage.
-- Links unlinked flowsheet rows to library rows whose normalized
-- (artist_name, album_title) text is identical, skipping the LML round-trip
-- entirely. Designed to run before flowsheet-lml-link-backfill so the LML
-- job processes a smaller residual.
--
-- Why this exists:
--   The default linkage path goes through LML, which on cache-miss takes
--   3-7 s per row. About 6.7% of unlinked flowsheet rows already have an
--   exact normalized text twin in the library — for those rows the LML
--   call is wasted work. This SQL pass links them in one transaction.
--
-- Normalization (applied to both sides):
--   - lowercase
--   - strip leading 'the '
--   - strip non-alphanumeric (collapses punctuation, parens, dashes)
--
-- Confidence: 1.0. The HAVING count(DISTINCT l.id) = 1 clause excludes
-- ambiguous matches (same normalized text resolves to >1 library row,
-- ~0.4% of matched rows). Those fall through to LML for B-2.3's tie-break.
--
-- Idempotent: the WHERE f.album_id IS NULL guard means re-runs are no-ops.
-- The first prod run linked 52,984 rows on 2026-04-27.
--
-- Reversible:
--   UPDATE wxyc_schema.flowsheet
--   SET album_id = NULL,
--       linkage_source = NULL,
--       linkage_confidence = NULL,
--       linked_at = NULL
--   WHERE linkage_source = 'direct_text_match';
--
-- Run procedure (interactive — review the dry-run before committing):
--   1. Wrap the UPDATE in a transaction with ROLLBACK to verify row count:
--        BEGIN;
--        <the UPDATE below>;
--        SELECT count(*) FROM wxyc_schema.flowsheet WHERE linkage_source = 'direct_text_match';
--        ROLLBACK;
--   2. If the count looks right, replace ROLLBACK with COMMIT and re-run.
--
-- Or run via scripts/query-flowsheet.sh as a one-shot SQL invocation.

SET statement_timeout = '600s';

WITH unlinked AS (
  SELECT
    f.id,
    lower(regexp_replace(regexp_replace(coalesce(f.artist_name, ''), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi')) AS artist_norm,
    lower(regexp_replace(regexp_replace(coalesce(f.album_title, ''), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi')) AS album_norm
  FROM wxyc_schema.flowsheet f
  WHERE f.album_id IS NULL
    AND f.entry_type = 'track'
    AND f.artist_name IS NOT NULL
    AND f.album_title IS NOT NULL
    AND (f.legacy_release_id IS NULL OR f.legacy_link_attempted_at IS NOT NULL)
),
lib AS (
  SELECT
    l.id,
    lower(regexp_replace(regexp_replace(coalesce(a.artist_name, ''), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi')) AS artist_norm,
    lower(regexp_replace(regexp_replace(coalesce(l.album_title, ''), '^the\s+', '', 'i'), '[^a-z0-9 ]+', '', 'gi')) AS album_norm
  FROM wxyc_schema.library l
  LEFT JOIN wxyc_schema.artists a ON a.id = l.artist_id
),
unique_matches AS (
  SELECT u.id AS flowsheet_id, min(l.id) AS library_id
  FROM unlinked u
  JOIN lib l
    ON l.artist_norm = u.artist_norm
   AND l.album_norm  = u.album_norm
  GROUP BY u.id
  HAVING count(DISTINCT l.id) = 1
)
UPDATE wxyc_schema.flowsheet f
SET album_id           = m.library_id,
    linkage_source     = 'direct_text_match',
    linkage_confidence = 1.0,
    linked_at          = now()
FROM unique_matches m
WHERE f.id = m.flowsheet_id
  AND f.album_id IS NULL;
