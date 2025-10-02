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

INSERT INTO wxyc_schema.rotation(album_id, play_freq) VALUES (1, 'L');

-- Test users for automated testing
INSERT INTO wxyc_schema.user(
    id, name, email, username, display_username, app_skin, created_at, updated_at)
    VALUES ('1', 'Test dj1', 'test1@wxyc.org', 'testdj1', 'Test dj1', 'modern-light', NOW(), NOW());

INSERT INTO wxyc_schema.user(
    id, name, email, username, display_username, app_skin, created_at, updated_at)
    VALUES ('2', 'Test dj2', 'test2@wxyc.org', 'testdj2', 'Test dj2', 'modern-light', NOW(), NOW());

-- Create WXYC organization
INSERT INTO wxyc_schema.organization(
    id, name, slug, created_at)
    VALUES ('wxyc-org', 'WXYC 89.3 FM', 'wxyc', NOW());

-- Add test users as members of WXYC organization
INSERT INTO wxyc_schema.member(
    id, organization_id, user_id, role, created_at)
    VALUES ('member-1', 'wxyc-org', '1', 'dj', NOW());

INSERT INTO wxyc_schema.member(
    id, organization_id, user_id, role, created_at)
    VALUES ('member-2', 'wxyc-org', '2', 'music-director', NOW());

-- Add an admin user for testing
INSERT INTO wxyc_schema.user(
    id, name, email, username, display_username, app_skin, created_at, updated_at)
    VALUES ('3', 'Test Admin', 'admin@wxyc.org', 'testadmin', 'Test Admin', 'modern-light', NOW(), NOW());

INSERT INTO wxyc_schema.member(
    id, organization_id, user_id, role, created_at)
    VALUES ('member-3', 'wxyc-org', '3', 'admin', NOW());