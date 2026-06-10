-- One-shot cleanup (BS#1382): delete `artist_search_alias` rows where
-- `source='discogs_name_variation'` and the variant normalizes to the
-- same key as the canonical `artists.artist_name`.
--
-- Why this exists:
--   The BS#1368 Path A frequency analysis (120 upcoming Triangle concerts)
--   surfaced 3 alias-only matches over strict-name; all three audit as
--   likely false positives. Two distinct FP shapes; this script covers
--   Shape 1 (substrate side). Shape 2 (consumer-side `discogs_member`
--   distinction) is tracked separately under BS#1383.
--
--   Shape 1 — `discogs_name_variation` emits no-op variants
--   (norm-equivalent to canonical): a variant whose normalized form
--   equals the canonical's normalized form adds zero recall over the
--   canonical row (anything that would match the variant already matches
--   the canonical post-normalization) while actively introducing FPs by
--   colliding the de-normalized form against same-named distinct library
--   artists. The audit surfaced two instances of the leading-"The"-strip
--   subform:
--
--     artist_id | canonical    | no-op variant  | collides with
--     ----------+--------------+----------------+---------------------
--           260 | "The Format" | "Format"       | a different "Format"
--         20351 | "The Snares" | "Snares"       | a different "Snares"
--
--   The rule is general — any `discogs_name_variation` row whose
--   normalized form equals the canonical's is dead weight. Case-only and
--   accent-only variants collapse the same way as the leading-"The"
--   subform under the canonical normalization key
--   (`wxyc_schema.normalize_artist_name(text)`, migration 0092).
--
-- Companion code change:
--   `jobs/artist-search-alias-consumer/writer.ts` is updated in the same
--   PR to reject these rows at write time so the substrate stays clean
--   going forward. Without the writer-side fix this script is a one-shot
--   patch — the next nightly run of the consumer would write the no-op
--   rows back.
--
-- Scope:
--   Only `source='discogs_name_variation'`. The other three sources
--   (`discogs_alias` / `discogs_member` / `wxyc_library_alt`) carry
--   relational or curatorial signal that does not collapse on
--   normalization — a `discogs_alias` row whose text matches its
--   canonical may still be a curated synonym worth preserving in the
--   substrate. (Shape 2's `discogs_member` consumer fix is in BS#1383.)
--
-- Expected scale (from the BS#1368 audit body):
--   Dozens, not thousands. The pre-flight SELECT below is the
--   verify-before-mutate check; abort if the count is materially higher
--   than expected.
--
-- Idempotent: the WHERE clause matches only rows still in the no-op
-- shape, so re-running is a no-op once the writer-side fix is deployed
-- and any earlier no-op rows have been cleared.
--
-- Per WXYC data-safety rule: SELECT scope first, then DELETE.
--
-- Run as operator post-deploy of the writer-side fix:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f scripts/cleanup-no-op-name-variations.sql

\echo '-- pre-flight scope by source (only discogs_name_variation should appear):'
SELECT
  asa.source,
  COUNT(*) AS no_op_count
FROM wxyc_schema.artist_search_alias asa
JOIN wxyc_schema.artists a ON a.id = asa.artist_id
WHERE wxyc_schema.normalize_artist_name(asa.variant)
    = wxyc_schema.normalize_artist_name(a.artist_name)
GROUP BY asa.source
ORDER BY asa.source;

\echo '-- audit sample (top 20 to-be-deleted rows, BS#1368-style table):'
SELECT
  asa.artist_id,
  a.artist_name AS canonical,
  asa.variant   AS no_op_variant,
  asa.source,
  asa.last_verified_at
FROM wxyc_schema.artist_search_alias asa
JOIN wxyc_schema.artists a ON a.id = asa.artist_id
WHERE asa.source = 'discogs_name_variation'
  AND wxyc_schema.normalize_artist_name(asa.variant)
    = wxyc_schema.normalize_artist_name(a.artist_name)
ORDER BY asa.artist_id, asa.variant
LIMIT 20;

\echo '-- delete:'
BEGIN;

DELETE FROM wxyc_schema.artist_search_alias asa
USING wxyc_schema.artists a
WHERE asa.artist_id = a.id
  AND asa.source = 'discogs_name_variation'
  AND wxyc_schema.normalize_artist_name(asa.variant)
    = wxyc_schema.normalize_artist_name(a.artist_name);

\echo '-- post-delete scope (expect zero discogs_name_variation no-op rows):'
SELECT
  asa.source,
  COUNT(*) AS no_op_count
FROM wxyc_schema.artist_search_alias asa
JOIN wxyc_schema.artists a ON a.id = asa.artist_id
WHERE wxyc_schema.normalize_artist_name(asa.variant)
    = wxyc_schema.normalize_artist_name(a.artist_name)
GROUP BY asa.source
ORDER BY asa.source;

COMMIT;

-- @no-analyze-needed: the DELETE removes a small number of rows (audit
--   expects dozens, not thousands) from a table where the relevant
--   indexes (`artist_search_alias_variant_trgm_idx` GIN,
--   `artist_search_alias_normalized_variant_idx` btree on the functional
--   form) are over the variant column, not its presence/absence. Planner
--   stats drift from a sub-thousand-row DELETE is below the noise floor.
