-- Primary and secondary dj used in test automation
-- Note: In production, users should be created via better-auth service
-- For test/dev environments, we create test users directly in the seed file

-- Create test users for test automation
-- These users are required for the test suite to function
INSERT INTO auth_user (id, name, email, email_verified, username, dj_name, real_name, created_at, updated_at, app_skin)
VALUES 
  ('test-dj1-id-00000000000000000001', 'test_dj1', 'test_dj1@wxyc.org', true, 'test_dj1', 'Test dj1', 'Test DJ 1', NOW(), NOW(), 'modern-light'),
  ('test-dj2-id-00000000000000000002', 'test_dj2', 'test_dj2@wxyc.org', true, 'test_dj2', 'Test dj2', 'Test DJ 2', NOW(), NOW(), 'modern-light')
ON CONFLICT (id) DO NOTHING;

-- Genres, media formats, artists, and albums used in test automation
INSERT INTO wxyc_schema.genres(genre_name) VALUES ('Rock');
INSERT INTO wxyc_schema.genres(genre_name) VALUES ('Hiphop');

INSERT INTO wxyc_schema.format(format_name) VALUES ('cd');
INSERT INTO wxyc_schema.format(format_name) VALUES ('vinyl');

INSERT INTO wxyc_schema.artists(
	artist_name, code_letters, code_artist_number, genre_id)
	VALUES ('Built to Spill', 'BU', 60, 1);

INSERT INTO wxyc_schema.artists(
	artist_name, code_letters, code_artist_number, genre_id)
	VALUES ('Ravyn Lenae', 'LE', 35, 2);

INSERT INTO wxyc_schema.artists(
	artist_name, code_letters, code_artist_number, genre_id)
	VALUES ('Jockstrap', 'JO', 108, 1);

INSERT INTO wxyc_schema.library(
    artist_id, genre_id, format_id, album_title, code_number) 
    VALUES (1, 1, 1, 'Keep it Like a Secret', 8);

INSERT INTO wxyc_schema.library(
    artist_id, genre_id, format_id, album_title, code_number) 
    VALUES (2, 2, 1, 'Crush', 1);

INSERT INTO wxyc_schema.library(
    artist_id, genre_id, format_id, album_title, code_number) 
    VALUES (3, 1, 2, 'I Love You Jennifer B', 1);

INSERT INTO wxyc_schema.rotation(album_id, play_freq) VALUES (1, 'L')