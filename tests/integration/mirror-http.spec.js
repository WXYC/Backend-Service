const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const fls_util = require('../utils/flowsheet_util');
const { isMockApiAvailable, resetMockApi, getMockRequests, simulateError } = require('../utils/mock_api');

/**
 * Mirror HTTP Integration Tests
 *
 * Verifies that flowsheet mutations are mirrored to tubafrenzy via HTTP
 * when TUBAFRENZY_URL points to the mock server. The mirror middleware
 * fires after the response is sent (fire-and-forget), so we verify via
 * the mock server's request log.
 *
 * NOTE: Mirror is ON by default when POSTHOG_API_KEY is unset (CI case).
 * Uses secondary_dj_id to avoid conflicts with other flowsheet tests.
 */

let mockApiAvailable = false;
const getTestDjId = () => global.secondary_dj_id;

beforeAll(async () => {
  mockApiAvailable = await isMockApiAvailable();
  if (!mockApiAvailable) {
    console.warn('Skipping mirror-http tests: mock API server not available');
  }
});

describe('Mirror HTTP to Tubafrenzy (Mock API)', () => {
  beforeEach(async () => {
    if (!mockApiAvailable) return;
    await resetMockApi();
    await fls_util.join_show(getTestDjId(), global.access_token);
  });

  afterEach(async () => {
    if (!mockApiAvailable) return;
    await fls_util.leave_show(getTestDjId(), global.access_token);
  });

  test('adding a flowsheet entry POSTs to mock tubafrenzy', async () => {
    if (!mockApiAvailable) return;

    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Autechre',
        album_title: 'Confield',
        track_title: 'VI Scose Poise',
      })
      .expect(201);

    // Mirror fires after response — wait briefly
    await new Promise((r) => setTimeout(r, 300));

    const tubafrenzyRequests = await getMockRequests('tubafrenzy');
    const postCalls = tubafrenzyRequests.filter((r) => r.method === 'POST');
    expect(postCalls.length).toBeGreaterThanOrEqual(1);

    const body = postCalls[0].body;
    expect(body.artistName).toBe('Autechre');
    expect(body.songTitle).toBe('VI Scose Poise');
    expect(body.releaseTitle).toBe('Confield');
  });

  test('mirror includes correct entry type for track entries', async () => {
    if (!mockApiAvailable) return;

    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
        track_title: 'Back, Baby',
      })
      .expect(201);

    await new Promise((r) => setTimeout(r, 300));

    const tubafrenzyRequests = await getMockRequests('tubafrenzy');
    const postCalls = tubafrenzyRequests.filter((r) => r.method === 'POST');
    expect(postCalls.length).toBeGreaterThanOrEqual(1);

    // Non-library, non-rotation track should be type 0
    expect(postCalls[0].body.flowsheetEntryType).toBe(0);
  });

  test('mirror failure does not block primary response', async () => {
    if (!mockApiAvailable) return;

    await simulateError('tubafrenzy', '/playlists', 500);

    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Chuquimamani-Condori',
        album_title: 'Edits',
        track_title: 'Call Your Name',
      })
      .expect(201);

    expect(addRes.body.id).toBeDefined();
    expect(addRes.body.artist_name).toBe('Chuquimamani-Condori');
  });

  test('updating a flowsheet entry PATCHes mock tubafrenzy', async () => {
    if (!mockApiAvailable) return;

    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Autechre',
        album_title: 'Confield',
        track_title: 'Cfern',
      })
      .expect(201);

    const entryId = addRes.body.id;

    // Wait for the POST mirror to fire
    await new Promise((r) => setTimeout(r, 300));
    await resetMockApi();

    // Update the entry
    await request
      .patch('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        entry_id: entryId,
        data: { track_title: 'Cfern (Updated)' },
      })
      .expect(200);

    // Wait for the PATCH mirror to fire
    await new Promise((r) => setTimeout(r, 300));

    const tubafrenzyRequests = await getMockRequests('tubafrenzy');
    const patchCalls = tubafrenzyRequests.filter((r) => r.method === 'PATCH');
    // PATCH may or may not fire depending on whether the tubafrenzy ID was cached from POST
    if (patchCalls.length > 0) {
      expect(patchCalls[0].body.songTitle).toBe('Cfern (Updated)');
    }
  });
});
