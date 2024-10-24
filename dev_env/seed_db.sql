-- Primary and secondary dj used in test automation
INSERT INTO wxyc_schema.djs(cognito_user_name, dj_name) VALUES ('test_dj1', 'Test dj1');
INSERT INTO wxyc_schema.djs(cognito_user_name, dj_name) VALUES ('test_dj2', 'Test dj2');
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
    VALUES (3, 1, 2, 'I love you Jennifer B', 1);