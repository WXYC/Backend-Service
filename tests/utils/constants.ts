/**
 * Test constants for reuse across test files.
 */

// Valid UUID v4 format strings
export const VALID_UUIDS = [
  '550e8400-e29b-41d4-a716-446655440000',
  '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
  'f47ac10b-58cc-4372-a567-0e02b2c3d479',
] as const;

// Invalid UUID strings for negative testing
export const INVALID_UUIDS = [
  '',
  'not-a-uuid',
  '550e8400e29b41d4a716446655440000', // no dashes
  '550e8400-e29b-41d4-a716', // too short
  '550e8400-e29b-41d4-a716-446655440000-extra', // too long
  'gggggggg-gggg-gggg-gggg-gggggggggggg', // invalid hex chars
  '550e840-e29b-41d4-a716-446655440000', // first segment too short
  '550e8400-e29-41d4-a716-446655440000', // second segment too short
] as const;

// A single valid UUID for simple tests
export const TEST_UUID = VALID_UUIDS[0];

// A single valid uppercase UUID
export const TEST_UUID_UPPERCASE = '550E8400-E29B-41D4-A716-446655440000';
