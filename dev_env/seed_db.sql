-- ==============================================================================
-- Test Users for E2E Authentication Tests
-- ==============================================================================
-- Note: In production, users should be created via better-auth service
-- For test/dev environments, we create test users directly in the seed file
--
-- IMPORTANT: These users are created without passwords in the seed.
-- Passwords are set by the auth service at startup (CREATE_DEFAULT_USER=TRUE)
-- or can be set by running the auth service's user creation flow.
--
-- For E2E tests, all test users use password: testpassword123
-- The auth service should be configured to create these accounts on startup.
-- ==============================================================================

-- Create test organization first (required for member roles)
INSERT INTO auth_organization (id, name, slug, created_at)
VALUES ('test-org-id-0000000000000000001', 'Test Organization', 'test-org', NOW())
ON CONFLICT (id) DO NOTHING;

-- Create test users for test automation
-- These users are required for the E2E test suite to function
INSERT INTO auth_user (id, name, email, email_verified, username, dj_name, real_name, role, created_at, updated_at, app_skin)
VALUES
  -- Member (no org role beyond member)
  ('test-member-id-000000000000000001', 'test_member', 'test_member@wxyc.org', true, 'test_member', 'Test Member DJ', 'Test Member', NULL, NOW(), NOW(), 'modern-light'),
  -- DJ users
  ('test-dj1-id-00000000000000000001', 'test_dj1', 'test_dj1@wxyc.org', true, 'test_dj1', 'Test dj1', 'Test DJ 1', NULL, NOW(), NOW(), 'modern-light'),
  ('test-dj2-id-00000000000000000002', 'test_dj2', 'test_dj2@wxyc.org', true, 'test_dj2', 'Test dj2', 'Test DJ 2', NULL, NOW(), NOW(), 'modern-light'),
  -- Music Director
  ('test-md-id-0000000000000000001', 'test_music_director', 'test_music_director@wxyc.org', true, 'test_music_director', 'Test MD', 'Test Music Director', NULL, NOW(), NOW(), 'modern-light'),
  -- Station Manager (with admin role for Better Auth Admin plugin)
  ('test-sm-id-0000000000000000001', 'test_station_manager', 'test_station_manager@wxyc.org', true, 'test_station_manager', 'Test SM', 'Test Station Manager', 'admin', NOW(), NOW(), 'modern-light'),
  -- Incomplete user (missing realName and djName for onboarding tests)
  ('test-incomplete-id-0000000000001', 'test_incomplete', 'test_incomplete@wxyc.org', true, 'test_incomplete', '', '', NULL, NOW(), NOW(), 'modern-light'),
  -- Deletable user (for admin deletion tests)
  ('test-deletable-id-00000000000001', 'test_deletable_user', 'test_deletable@wxyc.org', true, 'test_deletable_user', 'Deletable DJ', 'Test Deletable', NULL, NOW(), NOW(), 'modern-light'),
  -- Promotable user (for role modification tests)
  ('test-promotable-id-0000000000001', 'test_promotable_user', 'test_promotable@wxyc.org', true, 'test_promotable_user', 'Promotable DJ', 'Test Promotable', NULL, NOW(), NOW(), 'modern-light'),
  -- Demotable Station Manager (for role demotion tests)
  ('test-demotable-sm-id-000000000001', 'test_demotable_sm', 'test_demotable_sm@wxyc.org', true, 'test_demotable_sm', 'Demotable SM', 'Test Demotable SM', 'admin', NOW(), NOW(), 'modern-light')
ON CONFLICT (id) DO NOTHING;

-- Create credential accounts for all test users
-- Note: Password hash is for 'testpassword123' using scrypt (Better Auth default)
-- The hash below is a placeholder - actual hashes are created by the auth service
-- For local dev, use CREATE_DEFAULT_USER=TRUE to create users with proper passwords
INSERT INTO auth_account (id, user_id, account_id, provider_id, created_at, updated_at)
VALUES
  ('test-account-member-00000000001', 'test-member-id-000000000000000001', 'test-member-id-000000000000000001', 'credential', NOW(), NOW()),
  ('test-account-dj1-000000000001', 'test-dj1-id-00000000000000000001', 'test-dj1-id-00000000000000000001', 'credential', NOW(), NOW()),
  ('test-account-dj2-000000000001', 'test-dj2-id-00000000000000000002', 'test-dj2-id-00000000000000000002', 'credential', NOW(), NOW()),
  ('test-account-md-0000000000001', 'test-md-id-0000000000000000001', 'test-md-id-0000000000000000001', 'credential', NOW(), NOW()),
  ('test-account-sm-0000000000001', 'test-sm-id-0000000000000000001', 'test-sm-id-0000000000000000001', 'credential', NOW(), NOW()),
  ('test-account-incomplete-00001', 'test-incomplete-id-0000000000001', 'test-incomplete-id-0000000000001', 'credential', NOW(), NOW()),
  ('test-account-deletable-00001', 'test-deletable-id-00000000000001', 'test-deletable-id-00000000000001', 'credential', NOW(), NOW()),
  ('test-account-promotable-0001', 'test-promotable-id-0000000000001', 'test-promotable-id-0000000000001', 'credential', NOW(), NOW()),
  ('test-account-demotable-sm-01', 'test-demotable-sm-id-000000000001', 'test-demotable-sm-id-000000000001', 'credential', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- Create organization memberships with appropriate roles
INSERT INTO auth_member (id, organization_id, user_id, role, created_at)
VALUES
  -- Member role
  ('test-membership-member-00001', 'test-org-id-0000000000000000001', 'test-member-id-000000000000000001', 'member', NOW()),
  -- DJ roles
  ('test-membership-dj1-0000001', 'test-org-id-0000000000000000001', 'test-dj1-id-00000000000000000001', 'dj', NOW()),
  ('test-membership-dj2-0000001', 'test-org-id-0000000000000000001', 'test-dj2-id-00000000000000000002', 'dj', NOW()),
  -- Music Director role
  ('test-membership-md-00000001', 'test-org-id-0000000000000000001', 'test-md-id-0000000000000000001', 'musicDirector', NOW()),
  -- Station Manager role
  ('test-membership-sm-00000001', 'test-org-id-0000000000000000001', 'test-sm-id-0000000000000000001', 'stationManager', NOW()),
  -- Incomplete user as DJ
  ('test-membership-incomplete', 'test-org-id-0000000000000000001', 'test-incomplete-id-0000000000001', 'dj', NOW()),
  -- Deletable user as DJ
  ('test-membership-deletable-1', 'test-org-id-0000000000000000001', 'test-deletable-id-00000000000001', 'dj', NOW()),
  -- Promotable user as member (for promotion tests)
  ('test-membership-promotable1', 'test-org-id-0000000000000000001', 'test-promotable-id-0000000000001', 'member', NOW()),
  -- Demotable SM as stationManager (for demotion tests)
  ('test-membership-demotable01', 'test-org-id-0000000000000000001', 'test-demotable-sm-id-000000000001', 'stationManager', NOW())
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