-- Minimal PostgreSQL seed for ETL E2E tests.
-- Only provides genres and formats (required by the library ETL to map releases).
-- All other data (artists, albums, flowsheet) should be created by the ETL itself.

INSERT INTO wxyc_schema.genres(genre_name) VALUES
  ('Rock'), ('Hiphop'), ('Electronic'), ('Jazz'), ('Reggae'),
  ('Classical'), ('Latin'), ('Blues'), ('Soundtracks'), ('Spoken'),
  ('Comedy'), ('Africa'), ('Asia'), ('OCS'), ('Xmas')
ON CONFLICT DO NOTHING;

INSERT INTO wxyc_schema.format(format_name) VALUES
  ('cd'), ('vinyl'), ('vinyl 12"'), ('vinyl 7"'), ('vinyl 10"'), ('cdr')
ON CONFLICT DO NOTHING;
