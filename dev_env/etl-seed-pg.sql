-- Minimal PostgreSQL seed for ETL E2E tests.
-- Only provides genres and formats (required by the library ETL to map releases).
-- All other data (artists, albums, flowsheet) should be created by the ETL itself.

-- Genre IDs must match production (alphabetical assignment from the initial ETL sync).
-- Using explicit IDs ensures compatibility with pg_dump snapshots and crossreference data.
INSERT INTO wxyc_schema.genres(id, genre_name) VALUES
  (1, 'Africa'), (2, 'Asia'), (3, 'Blues'), (4, 'Classical'), (5, 'Comedy'),
  (6, 'Hiphop'), (7, 'Jazz'), (8, 'Latin'), (9, 'OCS'), (10, 'Reggae'),
  (11, 'Rock'), (12, 'Soundtracks'), (13, 'Spoken'), (14, 'Xmas'), (15, 'Electronic')
ON CONFLICT (id) DO NOTHING;
SELECT setval('wxyc_schema.genres_id_seq', 15, true);

INSERT INTO wxyc_schema.format(format_name) VALUES
  ('cd'), ('vinyl'), ('vinyl 12"'), ('vinyl 7"'), ('vinyl 10"'), ('cdr')
ON CONFLICT DO NOTHING;
