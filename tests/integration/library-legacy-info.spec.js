const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

/**
 * Integration tests for GET /library/info?legacy_release_id=<id> (BS#1880).
 *
 * External callers (LML, wxyc.info, the request line) hold the tubafrenzy
 * `LIBRARY_RELEASE.ID` (= BS `library.legacy_release_id`), not the BS serial
 * `library.id`. This endpoint resolves the legacy id to the serial and returns
 * the same album payload as `?album_id=`, so the dj-site legacy permalink front
 * door can turn a legacy-keyed URL into the canonical `/dashboard/album/[serial]`.
 *
 * The seeded row (library.id=7100, legacy_release_id=65880, Autechre / Confield)
 * comes from tests/fixtures/shape.sql. Pure BS PG — no mock LML required.
 */

const SHAPE_LIBRARY_ID = 7100;
const SHAPE_LEGACY_ID = 65880;

describe('GET /library/info?legacy_release_id= (BS#1880)', () => {
  let auth;

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
  });

  test('resolves a legacy_release_id to the serial-keyed album', async () => {
    const res = await auth.get(`/library/info?legacy_release_id=${SHAPE_LEGACY_ID}`).expect(200);
    expect(res.body.id).toBe(SHAPE_LIBRARY_ID);
    expect(res.body.album_title).toBe('Confield');
  });

  test('returns the same album as the serial ?album_id= path', async () => {
    const byLegacy = await auth.get(`/library/info?legacy_release_id=${SHAPE_LEGACY_ID}`).expect(200);
    const bySerial = await auth.get(`/library/info?album_id=${SHAPE_LIBRARY_ID}`).expect(200);
    expect(byLegacy.body.id).toBe(bySerial.body.id);
    expect(byLegacy.body.album_title).toBe(bySerial.body.album_title);
  });

  test('returns 404 when the legacy_release_id maps to no catalog row', async () => {
    const res = await auth.get('/library/info?legacy_release_id=999999999').expect(404);
    expect(res.body.message ?? res.body.error ?? '').toMatch(/legacy_release_id/i);
  });

  test.each([['not-a-number'], ['0'], ['-5']])('returns 400 for an invalid legacy_release_id (%s)', async (bad) => {
    const res = await auth.get(`/library/info?legacy_release_id=${bad}`).expect(400);
    expect(res.body.message ?? res.body.error ?? '').toMatch(/legacy_release_id/i);
  });

  test('returns 400 when neither album_id nor legacy_release_id is provided', async () => {
    const res = await auth.get('/library/info').expect(400);
    expect(res.body.message ?? res.body.error ?? '').toMatch(/album identifier/i);
  });
});
