-- Primary and secondary dj used in test automation
-- Insert test users for better-auth
INSERT INTO wxyc_schema.user(id, email, name, "realName", "djName", onboarded) VALUES ('test-user-id', 'test@example.com', 'Test User', 'Test User', 'Test DJ', true);
INSERT INTO wxyc_schema.user(id, email, name, "realName", "djName", onboarded) VALUES ('test-user-id-2', 'test2@example.com', 'Test User 2', 'Test User 2', 'Test DJ 2', true);

-- Insert DJs with both old and new auth references for compatibility
INSERT INTO wxyc_schema.djs(cognito_user_name, user_id, dj_name, real_name) VALUES ('test_dj1', 'test-user-id', 'Test dj1', 'Test User');
INSERT INTO wxyc_schema.djs(cognito_user_name, user_id, dj_name, real_name) VALUES ('test_dj2', 'test-user-id-2', 'Test dj2', 'Test User 2');
-- If you'd like to test with auth uncomment the following line with your dj portal username.
-- INSERT INTO wxyc_schema.djs(cognito_user_name, dj_name) VALUES ('your_dj_portal_username', 'Your DJ NAME');

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