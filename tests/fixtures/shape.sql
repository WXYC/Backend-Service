-- ==============================================================================
-- Shape fixture for integration tests (issue #701)
-- ==============================================================================
-- Hand-curated edge-case rows that constraint-adding migrations would trip
-- over against real production data. Loaded by tests/setup/globalSetup.js
-- AFTER drizzle:migrate creates the schema and AFTER seed_db.sql seeds the
-- baseline rows.
--
-- The fixture is the test-side complement to the writeup in #701: any
-- migration that adds a UNIQUE / CHECK / NOT NULL constraint that's safe
-- against an empty test DB but lethal against real prod data should now
-- fail at fixture-load time (or in tests/integration/migrations.spec.ts)
-- in CI rather than in production. Recent example the fixture catches:
-- PR #696's `CREATE UNIQUE INDEX ... ON rotation (album_id, rotation_bin)
-- WHERE kill_date IS NULL` (3 duplicate groups in this fixture).
--
-- All inserts use ON CONFLICT (id) DO NOTHING so the file is idempotent
-- against repeat runs against the same schema. The conflict target is
-- always the primary key; we deliberately do NOT use a bare ON CONFLICT
-- DO NOTHING because that would silently swallow violations of the
-- unique partial indexes / CHECK constraints we want this fixture to
-- exercise.
--
-- ID conventions, picked to never collide with seed_db.sql (which uses
-- IDs 1-9 for artists/albums and creates rotation rows by serial) or
-- with rows integration tests insert at runtime:
--
--   artists, library, rotation, shows, labels: id range 7000-7099
--   genre_artist_crossreference uses (artist_id, genre_id) so its
--   uniqueness is naturally namespaced by the artist_id range.
--
-- Sequence values are advanced past the fixture range with setval() so
-- subsequent serial inserts (from tests or app code) don't collide.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- Labels
-- ------------------------------------------------------------------------------
INSERT INTO wxyc_schema.labels (id, label_name)
VALUES
  (7000, 'Shape Fixture Label A'),
  (7001, 'Shape Fixture Label B')
ON CONFLICT (id) DO NOTHING;

SELECT setval('wxyc_schema.labels_id_seq', 7099, true);

-- ------------------------------------------------------------------------------
-- Artists (code_letters intentionally outside the canonical seeded set)
-- ------------------------------------------------------------------------------
INSERT INTO wxyc_schema.artists (id, artist_name, alphabetical_name, code_letters)
VALUES
  (7000, 'Shape Fixture Artist Alpha', 'Shape Fixture Artist Alpha', 'XA'),
  (7001, 'Shape Fixture Artist Beta',  'Shape Fixture Artist Beta',  'XB'),
  (7002, 'Shape Fixture Artist Gamma', 'Shape Fixture Artist Gamma', 'XC')
ON CONFLICT (id) DO NOTHING;

SELECT setval('wxyc_schema.artists_id_seq', 7099, true);

-- Crossreference rows so library_artist_view INNER JOINs resolve. The
-- (artist_id, genre_id) unique key is namespaced by our 7000-range
-- artist IDs, so no conflict target is needed beyond the implicit
-- compound key.
INSERT INTO wxyc_schema.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
VALUES
  (7000, 11, 700),
  (7001, 11, 701),
  (7002, 11, 702)
ON CONFLICT (artist_id, genre_id) DO NOTHING;

-- ------------------------------------------------------------------------------
-- Library
--
-- 10 rows total. Includes:
--   * 1 row with NULL artist_name (#625-style assertion target)
--   * 6 well-formed rows, used as targets for rotation/flowsheet rows below
--   * 3 padding rows for variety (different formats / genres)
-- ------------------------------------------------------------------------------
INSERT INTO wxyc_schema.library
  (id, artist_id, genre_id, format_id, album_title, code_number, artist_name, label, label_id)
VALUES
  -- artist_name populated (the normal A.2-backfilled state)
  (7000, 7000, 11, 1, 'Shape Fixture Album Alpha 1',  1, 'Shape Fixture Artist Alpha', 'Shape Fixture Label A', 7000),
  (7001, 7000, 11, 1, 'Shape Fixture Album Alpha 2',  2, 'Shape Fixture Artist Alpha', 'Shape Fixture Label A', 7000),
  (7002, 7001, 11, 2, 'Shape Fixture Album Beta 1',   1, 'Shape Fixture Artist Beta',  'Shape Fixture Label B', 7001),
  (7003, 7001, 11, 2, 'Shape Fixture Album Beta 2',   2, 'Shape Fixture Artist Beta',  NULL,                    NULL),
  (7004, 7002, 11, 1, 'Shape Fixture Album Gamma 1',  1, 'Shape Fixture Artist Gamma', NULL,                    NULL),
  (7005, 7002, 11, 1, 'Shape Fixture Album Gamma 2',  2, 'Shape Fixture Artist Gamma', NULL,                    NULL),
  -- 1 row with NULL artist_name. Pre-#625 shape: would trip the
  -- library-artist-name-assertion service if encountered at boot.
  (7006, 7000, 11, 1, 'Shape Fixture Album NULL-artist',  3, NULL,                       NULL,                    NULL),
  -- Padding rows for rotation-bin variety
  (7007, 7001, 11, 1, 'Shape Fixture Album Beta 3',   3, 'Shape Fixture Artist Beta',  NULL,                    NULL),
  (7008, 7002, 11, 2, 'Shape Fixture Album Gamma 3',  3, 'Shape Fixture Artist Gamma', NULL,                    NULL),
  (7009, 7000, 11, 2, 'Shape Fixture Album Alpha 3',  4, 'Shape Fixture Artist Alpha', NULL,                    NULL)
ON CONFLICT (id) DO NOTHING;

SELECT setval('wxyc_schema.library_id_seq', 7099, true);

-- ------------------------------------------------------------------------------
-- Rotation (~15 rows)
--
-- Edge cases:
--   * 3 duplicate groups for (album_id, rotation_bin) WHERE kill_date IS NULL.
--     This is exactly the shape #696's unique partial index would have
--     rejected: 3 distinct rotation rows on album 7000 in bin 'H', 2 on
--     album 7002 in bin 'L', 2 on album 7001 in bin 'M'.
--   * 2 NULL album_id rows (rotation.album_id is FK-ON-DELETE-CASCADE
--     nullable). Real prod has these from tubafrenzy adds where the
--     library row was later deleted.
--   * 1 row with kill_date > CURRENT_DATE (the planner-stable predicate
--     `kill_date IS NULL` does NOT exclude this row even though the
--     semantically-richer "is active" predicate would).
-- ------------------------------------------------------------------------------
INSERT INTO wxyc_schema.rotation
  (id, album_id, rotation_bin, add_date, kill_date, artist_name, album_title, record_label, legacy_rotation_id)
VALUES
  -- Duplicate group 1: album 7000, bin 'H', 3 active rows
  (7000, 7000, 'H', '2024-01-01', NULL, 'Shape Fixture Artist Alpha', 'Shape Fixture Album Alpha 1', 'Shape Fixture Label A', 70000),
  (7001, 7000, 'H', '2024-03-15', NULL, 'Shape Fixture Artist Alpha', 'Shape Fixture Album Alpha 1', 'Shape Fixture Label A', 70001),
  (7002, 7000, 'H', '2024-08-22', NULL, 'Shape Fixture Artist Alpha', 'Shape Fixture Album Alpha 1', 'Shape Fixture Label A', 70002),
  -- Duplicate group 2: album 7002, bin 'L', 2 active rows
  (7003, 7002, 'L', '2024-02-01', NULL, 'Shape Fixture Artist Gamma', 'Shape Fixture Album Gamma 1', NULL,                    70003),
  (7004, 7002, 'L', '2024-06-10', NULL, 'Shape Fixture Artist Gamma', 'Shape Fixture Album Gamma 1', NULL,                    70004),
  -- Duplicate group 3: album 7001, bin 'M', 2 active rows
  (7005, 7001, 'M', '2024-04-01', NULL, 'Shape Fixture Artist Beta',  'Shape Fixture Album Beta 1',  'Shape Fixture Label B', 70005),
  (7006, 7001, 'M', '2024-10-12', NULL, 'Shape Fixture Artist Beta',  'Shape Fixture Album Beta 1',  'Shape Fixture Label B', 70006),
  -- 2 rows with NULL album_id (orphaned tubafrenzy rows)
  (7007, NULL, 'L', '2024-05-20', NULL, 'Shape Fixture Orphan One',   'Shape Fixture Orphan Album One', NULL,                70007),
  (7008, NULL, 'M', '2024-07-04', NULL, 'Shape Fixture Orphan Two',   'Shape Fixture Orphan Album Two', NULL,                70008),
  -- 1 row with kill_date > CURRENT_DATE (future-dated retirement).
  -- The planner-stable `WHERE kill_date IS NULL` predicate does NOT
  -- exclude this row, so a unique partial index over that predicate
  -- would still consider it. We add it on a NEW (album, bin) pair so
  -- it doesn't itself create a duplicate group.
  (7009, 7004, 'S', '2024-09-01', '2099-12-31', 'Shape Fixture Artist Gamma', 'Shape Fixture Album Gamma 1', NULL,            70009),
  -- Killed (kill_date in the past) rows for `WHERE kill_date IS NOT NULL` paths
  (7010, 7000, 'L', '2023-01-01', '2023-12-31', 'Shape Fixture Artist Alpha', 'Shape Fixture Album Alpha 1', 'Shape Fixture Label A', 70010),
  (7011, 7001, 'H', '2023-02-01', '2023-11-15', 'Shape Fixture Artist Beta',  'Shape Fixture Album Beta 1',  'Shape Fixture Label B', 70011),
  -- A few non-duplicate active rows for plain-shape coverage
  (7012, 7003, 'M', '2024-11-01', NULL, 'Shape Fixture Artist Beta',  'Shape Fixture Album Beta 2', NULL,                    70012),
  (7013, 7005, 'H', '2024-11-15', NULL, 'Shape Fixture Artist Gamma', 'Shape Fixture Album Gamma 2', NULL,                   70013),
  (7014, 7007, 'L', '2024-12-01', NULL, 'Shape Fixture Artist Beta',  'Shape Fixture Album Beta 3', NULL,                    70014)
ON CONFLICT (id) DO NOTHING;

SELECT setval('wxyc_schema.rotation_id_seq', 7099, true);

-- ------------------------------------------------------------------------------
-- Shows
--
-- Edge cases:
--   * 2 shows with end_time IS NULL (active / never-ended). Real prod
--     has these from DJs who started a show and didn't formally
--     end it.
--   * 1 show with legacy_show_id set (tubafrenzy-mirrored show; the
--     unique index on legacy_show_id would forbid duplicates if any
--     future migration tries to enforce a stricter shape).
--   * 1 ended show that owns the multi-play_order flowsheet rows
--     below.
-- ------------------------------------------------------------------------------
INSERT INTO wxyc_schema.shows
  (id, primary_dj_id, show_name, start_time, end_time, legacy_show_id, legacy_dj_name)
VALUES
  -- Active show #1 (end_time IS NULL)
  (7000, NULL, 'Shape Fixture Active Show One', '2024-12-01 18:00:00+00', NULL, NULL,    'Shape Fixture DJ One'),
  -- Active show #2 (end_time IS NULL)
  (7001, NULL, 'Shape Fixture Active Show Two', '2024-12-02 20:00:00+00', NULL, NULL,    'Shape Fixture DJ Two'),
  -- Ended show with legacy_show_id (tubafrenzy mirror)
  (7002, NULL, 'Shape Fixture Ended Legacy Show', '2024-11-15 18:00:00+00', '2024-11-15 21:00:00+00', 700002, 'Shape Fixture Legacy DJ'),
  -- Ended show that owns the multi-play_order flowsheet rows below
  (7003, NULL, 'Shape Fixture Mixed-Play-Order Show', '2024-11-20 18:00:00+00', '2024-11-20 21:00:00+00', NULL, 'Shape Fixture DJ Mixed')
ON CONFLICT (id) DO NOTHING;

SELECT setval('wxyc_schema.shows_id_seq', 7099, true);

-- ------------------------------------------------------------------------------
-- Flowsheet (~10 rows across 2 shows)
--
-- Edge cases:
--   * Show 7003 contains play_orders 1, 2, 3, 4, AND 471 — the
--     471 row exposes the per-show vs global-MAX assumption that
--     #693 (BS#693) hit on prod when nextPlayOrder() did SELECT
--     MAX(play_order) FROM flowsheet (no WHERE show_id) and
--     legacy tubafrenzy webhook-set play_orders mixed with dj-site
--     globally-maxed play_orders.
--   * Show 7000 carries a mix of entry_types (track + dj_join +
--     show_start) so any assumption that flowsheet is track-only
--     also surfaces.
--   * 1 track row with metadata_attempt_at = NULL (the explicit
--     "still-pending" shape #638 / #639 Phase 2 sweep targets).
--     The artist_name is non-NULL on that row so the partial
--     index `flowsheet_metadata_attempt_pending_idx` would index
--     it.
-- ------------------------------------------------------------------------------
INSERT INTO wxyc_schema.flowsheet
  (id, show_id, album_id, entry_type, track_title, album_title, artist_name, record_label,
   play_order, request_flag, segue, message, add_time, dj_name, metadata_attempt_at)
VALUES
  -- Show 7003: mixed play_orders within a single show (1, 2, 3, 4, 471)
  (7000, 7003, 7000, 'track', 'Shape Track One',   'Shape Fixture Album Alpha 1', 'Shape Fixture Artist Alpha', 'Shape Fixture Label A',
   1, false, false, NULL, '2024-11-20 18:05:00+00', 'Shape Fixture DJ Mixed', '2024-11-20 18:05:01+00'),
  (7001, 7003, 7001, 'track', 'Shape Track Two',   'Shape Fixture Album Alpha 2', 'Shape Fixture Artist Alpha', 'Shape Fixture Label A',
   2, false, false, NULL, '2024-11-20 18:10:00+00', 'Shape Fixture DJ Mixed', '2024-11-20 18:10:01+00'),
  (7002, 7003, 7002, 'track', 'Shape Track Three', 'Shape Fixture Album Beta 1',  'Shape Fixture Artist Beta',  'Shape Fixture Label B',
   3, false, false, NULL, '2024-11-20 18:15:00+00', 'Shape Fixture DJ Mixed', '2024-11-20 18:15:01+00'),
  (7003, 7003, 7003, 'track', 'Shape Track Four',  'Shape Fixture Album Beta 2',  'Shape Fixture Artist Beta',  NULL,
   4, false, false, NULL, '2024-11-20 18:20:00+00', 'Shape Fixture DJ Mixed', '2024-11-20 18:20:01+00'),
  -- The 471 outlier in the SAME show (#693 incident shape)
  (7004, 7003, 7004, 'track', 'Shape Track 471',   'Shape Fixture Album Gamma 1', 'Shape Fixture Artist Gamma', NULL,
   471, false, false, NULL, '2024-11-20 18:25:00+00', 'Shape Fixture DJ Mixed', '2024-11-20 18:25:01+00'),
  -- 1 track row with metadata_attempt_at = NULL (still-pending shape)
  (7005, 7003, 7005, 'track', 'Shape Track Pending Metadata', 'Shape Fixture Album Gamma 2', 'Shape Fixture Artist Gamma', NULL,
   5, false, false, NULL, '2024-11-20 18:30:00+00', 'Shape Fixture DJ Mixed', NULL),
  -- Show 7000: mixed entry_types
  (7006, 7000, NULL, 'show_start', NULL, NULL, NULL, NULL,
   1, false, false, 'Show start marker', '2024-12-01 18:00:00+00', 'Shape Fixture DJ One', NULL),
  (7007, 7000, NULL, 'dj_join',    NULL, NULL, NULL, NULL,
   2, false, false, NULL, '2024-12-01 18:01:00+00', 'Shape Fixture DJ One', NULL),
  (7008, 7000, 7006, 'track', 'Shape Track NULL-artist source', 'Shape Fixture Album NULL-artist', NULL, NULL,
   3, false, false, NULL, '2024-12-01 18:05:00+00', 'Shape Fixture DJ One', '2024-12-01 18:05:01+00'),
  -- Show 7001: a row with NULL album_id (free-form text-only entry)
  (7009, 7001, NULL, 'track', 'Shape Track Free-Form', 'Shape Fixture Free-Form Album', 'Shape Fixture Free-Form Artist', NULL,
   1, false, false, NULL, '2024-12-02 20:05:00+00', 'Shape Fixture DJ Two', '2024-12-02 20:05:01+00')
ON CONFLICT (id) DO NOTHING;

SELECT setval('wxyc_schema.flowsheet_id_seq', 7099, true);

-- ------------------------------------------------------------------------------
-- compilation_track_artist (BS#819 — integration tests for CTA-based track search)
--
-- Test-only CTA rows pointing at an existing shape-fixture library row so
-- track-title queries that miss the primary tsvector + trigram path fall
-- through to `searchLibraryByCTA`. Per the catalog-track-search plan §9.1,
-- these stay test-only (no wxyc-shared example data backflow) and reference
-- already-seeded library rows.
--
-- Track titles ("Bioluminescence", "Echolocation Hymn") are intentionally
-- unique tokens that don't appear in any seeded library row's album_title
-- or artist_name, so the primary path can't accidentally satisfy the query
-- and short-circuit the cascade before Track 1 runs.
-- ------------------------------------------------------------------------------
INSERT INTO wxyc_schema.compilation_track_artist
  (id, library_id, artist_name, track_title, track_position)
VALUES
  (7000, 7000, 'Shape Fixture Comp Guest Alpha', 'Bioluminescence',   'A1'),
  (7001, 7000, 'Shape Fixture Comp Guest Beta',  'Echolocation Hymn', 'A2'),
  (7002, 7000, 'Shape Fixture Comp Guest Gamma', 'Bioluminescence',   'B1')
ON CONFLICT (id) DO NOTHING;

SELECT setval('wxyc_schema.compilation_track_artist_id_seq', 7099, true);
