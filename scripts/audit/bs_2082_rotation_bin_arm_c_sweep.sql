-- BS#2082 Phase 1 deliverable: rotation_bin arm-(c) drop equivalence sweep.
--
-- This PR drops cohort (c) — a library+artists LEFT JOIN match — from the
-- `rotation_bin` COALESCE fallback subquery in
-- apps/backend/services/flowsheet.service.ts's FSEntryFieldsRaw, keeping
-- cohorts (a) (flowsheet.album_id match) and (b) (rotation's own
-- denormalized artist/album match). BS#2082's own equivalence check covered
-- only the newest 3,000 rows (value-identical) / 20,000 rows (arm-
-- contribution counts) / 50,000 rows (cohort-(a) reachability via
-- MAX_OFFSET) — the default page path can only reach the newest 50,030
-- rows, but `getEntriesByRange` / `GET /flowsheet/range` reach arbitrary
-- history and `rotation.add_date` goes back to 2004. This script extends
-- the check to EVERY fallback-firing row in history, and is the artifact
-- the Phase 2 AC on the issue requires be run against prod (read-only)
-- before the arm-(c) drop is allowed to merge.
--
-- What "fires" means, matching the live subquery's guard: a flowsheet row
-- with `rotation_id IS NULL` and non-empty (trimmed) `artist_name` /
-- `album_title`. Only those rows ever reach the fallback subquery — on
-- every other row the outer COALESCE short-circuits and this script's
-- comparison is moot (both old and new queries agree trivially: neither
-- runs).
--
-- Read-only: two SELECTs per invocation, no writes anywhere. This script
-- additionally sets `default_transaction_read_only` itself as a first
-- statement — belt-and-suspenders with the operator's own
-- `SET default_transaction_read_only = on;` prepend called for in the
-- issue's "Notes for implementer" (the same procedure as the #2032 index
-- swap).
--
-- id-cursor chunked, and chunked by CANDIDATE (fallback-firing) row count,
-- not by raw flowsheet id range — firing-row density is uneven across
-- history (the issue's own sample found the fallback firing on 46% of the
-- newest 20,000 rows; older history is unmeasured), so bounding by a fixed
-- id span does not bound wall-clock time the way bounding by candidate
-- count does. BS#2082 measured ~40ms per firing row for the AS-SHIPPED
-- (cohort-(c)-included) subquery; the default chunk_size below (100
-- candidates) is a ~4s worst case per invocation, safely inside the 5s RDS
-- `statement_timeout` this script must never trip (tripping it means the
-- chunk's SELECT is cancelled and produces neither a mismatch verdict nor
-- a usable cursor for that chunk — tune `chunk_size` down for a slower
-- instance rather than let that happen silently).
--
-- Usage — psql bind variables `after_id` (start at 0) and `chunk_size`:
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
--     -v after_id=0 -v chunk_size=100 \
--     -f scripts/audit/bs_2082_rotation_bin_arm_c_sweep.sql
--
-- Each invocation prints a PROGRESS row (candidates_checked,
-- min_id_in_chunk, max_id_checked) followed by zero or more MISMATCH rows.
-- Re-invoke with `after_id` set to the previous run's `max_id_checked`
-- until a PROGRESS row reports `candidates_checked = 0` — that is the end
-- of the table. Record on the issue: 0 MISMATCH rows across the full
-- sweep, or the enumerated mismatching flowsheet ids for judgment, per the
-- Phase 2 AC.

SET default_transaction_read_only = on;

-- Progress row: how many fallback-firing candidates this chunk covered,
-- and the id cursor to pass as :after_id on the next invocation.
-- candidates_checked = 0 means the sweep has reached the end of the table.
WITH candidates AS (
  SELECT f.id, f.add_time, f.album_id, f.artist_name, f.album_title
  FROM wxyc_schema.flowsheet f
  WHERE f.id > :after_id
    AND f.rotation_id IS NULL
    AND coalesce(f.artist_name, '') <> ''
    AND coalesce(f.album_title, '') <> ''
  ORDER BY f.id
  LIMIT :chunk_size
)
SELECT
  'PROGRESS' AS marker,
  count(*) AS candidates_checked,
  coalesce(min(id), :after_id) AS min_id_in_chunk,
  coalesce(max(id), :after_id) AS max_id_checked
FROM candidates;

-- Mismatches: fallback-firing rows whose rotation_bin value would CHANGE
-- once cohort (c) is dropped. Both subqueries below are kept byte-
-- identical (modulo the alias `c` standing in for the flowsheet row) to
-- the as-shipped and post-PR shapes of
-- apps/backend/services/flowsheet.service.ts's FSEntryFieldsRaw.rotation_bin
-- fallback, including the BS#1526 window bounds and the `ORDER BY r2.id
-- LIMIT 1` oldest-active-row tie-break — this script is deliberately NOT
-- an independent reimplementation, so it rots the same day the live
-- query's shape changes rather than silently drifting into a false
-- source of confidence.
WITH candidates AS (
  SELECT f.id, f.add_time, f.album_id, f.artist_name, f.album_title
  FROM wxyc_schema.flowsheet f
  WHERE f.id > :after_id
    AND f.rotation_id IS NULL
    AND coalesce(f.artist_name, '') <> ''
    AND coalesce(f.album_title, '') <> ''
  ORDER BY f.id
  LIMIT :chunk_size
),
compared AS (
  SELECT
    c.id,
    c.add_time,
    -- Old value: as-shipped, cohorts (a) + (b) + (c).
    (
      SELECT r2.rotation_bin
      FROM wxyc_schema.rotation r2
      LEFT JOIN wxyc_schema.library l2 ON l2.id = r2.album_id
      LEFT JOIN wxyc_schema.artists a2 ON a2.id = l2.artist_id
      WHERE r2.add_date <= c.add_time::date
        AND (r2.kill_date IS NULL OR r2.kill_date > c.add_time::date)
        AND (
          (c.album_id IS NOT NULL AND r2.album_id = c.album_id)
          OR (
            lower(trim(coalesce(r2.artist_name, ''))) = lower(trim(c.artist_name))
            AND lower(trim(coalesce(r2.album_title, ''))) = lower(trim(c.album_title))
          )
          OR (
            lower(trim(coalesce(a2.artist_name, ''))) = lower(trim(c.artist_name))
            AND lower(trim(coalesce(l2.album_title, ''))) = lower(trim(c.album_title))
          )
        )
      ORDER BY r2.id
      LIMIT 1
    ) AS old_value_with_arm_c,
    -- New value: post-PR, cohorts (a) + (b) only.
    (
      SELECT r2.rotation_bin
      FROM wxyc_schema.rotation r2
      WHERE r2.add_date <= c.add_time::date
        AND (r2.kill_date IS NULL OR r2.kill_date > c.add_time::date)
        AND (
          (c.album_id IS NOT NULL AND r2.album_id = c.album_id)
          OR (
            lower(trim(coalesce(r2.artist_name, ''))) = lower(trim(c.artist_name))
            AND lower(trim(coalesce(r2.album_title, ''))) = lower(trim(c.album_title))
          )
        )
      ORDER BY r2.id
      LIMIT 1
    ) AS new_value_without_arm_c
  FROM candidates c
)
SELECT
  'MISMATCH' AS marker,
  id AS flowsheet_id,
  add_time,
  old_value_with_arm_c,
  new_value_without_arm_c
FROM compared
WHERE old_value_with_arm_c IS DISTINCT FROM new_value_without_arm_c
ORDER BY id;
