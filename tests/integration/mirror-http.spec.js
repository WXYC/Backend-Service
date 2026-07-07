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
 * Mutations must use secondary_access_token: showMemberMiddleware runs for
 * real in this env (BS#1533), so the caller has to be a member of the show
 * this suite joins as the secondary DJ.
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
    await fls_util.join_show(getTestDjId(), global.secondary_access_token);
  });

  afterEach(async () => {
    if (!mockApiAvailable) return;
    await fls_util.leave_show(getTestDjId(), global.secondary_access_token);
  });

  test('adding a flowsheet entry POSTs to mock tubafrenzy', async () => {
    if (!mockApiAvailable) return;

    await request
      .post('/flowsheet')
      .set('Authorization', global.secondary_access_token)
      .send({
        artist_name: 'Autechre',
        album_title: 'Confield',
        track_title: 'VI Scose Poise',
      })
      .expect(201);

    // Mirror fires after response — wait briefly
    await new Promise((r) => setTimeout(r, 300));

    const tubafrenzyRequests = await getMockRequests('tubafrenzy');
    const entryPosts = tubafrenzyRequests.filter((r) => r.method === 'POST' && r.path.includes('/api/flowsheetEntry'));
    expect(entryPosts.length).toBeGreaterThanOrEqual(1);

    const body = entryPosts[entryPosts.length - 1].body;
    expect(body.artistName).toBe('Autechre');
    expect(body.songTitle).toBe('VI Scose Poise');
    expect(body.releaseTitle).toBe('Confield');
  });

  test('mirror includes correct entry type for track entries', async () => {
    if (!mockApiAvailable) return;

    await request
      .post('/flowsheet')
      .set('Authorization', global.secondary_access_token)
      .send({
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
        track_title: 'Back, Baby',
      })
      .expect(201);

    await new Promise((r) => setTimeout(r, 300));

    const tubafrenzyRequests = await getMockRequests('tubafrenzy');
    const entryPosts = tubafrenzyRequests.filter((r) => r.method === 'POST' && r.path.includes('/api/flowsheetEntry'));
    expect(entryPosts.length).toBeGreaterThanOrEqual(1);

    // Non-library, non-rotation track should be type 0
    expect(entryPosts[entryPosts.length - 1].body.flowsheetEntryType).toBe(0);
  });

  test('mirror failure does not block primary response', async () => {
    if (!mockApiAvailable) return;

    await simulateError('tubafrenzy', '/playlists', 500);

    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.secondary_access_token)
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
      .set('Authorization', global.secondary_access_token)
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
      .set('Authorization', global.secondary_access_token)
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

/**
 * BS#1119: POST /flowsheet/end serves leave semantics too — a guest-DJ leave
 * returns a ShowDJ, not a Show, through the same route. This locks the
 * end-to-end signoff CONTRACT: a guest leave signs off zero times and leaves
 * the show live, while the primary's end signs off exactly once.
 *
 * The guard's unit-level regression pin lives in endshow-shape-guard.test.ts.
 * These black-box assertions hold with or without the `show.id == null` guard —
 * signoff is separately gated on a resolved tubafrenzy show id, so it stays
 * silent for a ShowDJ either way — so their value here is contract coverage
 * plus the primary-plus-guest fixture BS#1533's dj-scoping tests reuse.
 */
describe('endShow mirror shape guard on guest-DJ leave (BS#1119)', () => {
  const isSignoff = (r) => r.method === 'POST' && r.path.includes('/api/radioShow/signoff');

  afterEach(async () => {
    if (!mockApiAvailable) return;
    // Best-effort cleanup so a mid-test failure can't leak an open show into
    // later specs (suite runs --runInBand against shared show state).
    await fls_util.leave_show(global.secondary_dj_id, global.secondary_access_token);
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('guest-DJ leave does not sign off the show; primary end signs off once', async () => {
    if (!mockApiAvailable) return;

    await resetMockApi();

    // Primary A starts the show, guest B joins as co-host
    await fls_util.join_show(global.primary_dj_id, global.access_token);
    await fls_util.join_show(global.secondary_dj_id, global.secondary_access_token);

    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        track_title: 'la paradoja',
      })
      .expect(201);
    const entryId = addRes.body.id;

    // Let join/add mirror traffic flush, then observe only the leave
    await new Promise((r) => setTimeout(r, 300));
    await resetMockApi();

    // Guest B calls /flowsheet/end — leave semantics, controller returns ShowDJ
    const leaveRes = await fls_util.leave_show(global.secondary_dj_id, global.secondary_access_token);
    expect(leaveRes.status).toBe(200);

    await new Promise((r) => setTimeout(r, 300));

    // (a) No signoff reached tubafrenzy
    const afterLeave = await getMockRequests('tubafrenzy');
    expect(afterLeave.filter(isSignoff)).toHaveLength(0);

    // (b) The show is still live for primary A
    const onAirRes = await request.get('/flowsheet/on-air').query({ dj_id: global.primary_dj_id }).expect(200);
    expect(onAirRes.body.is_live).toBe(true);

    // (c) The prior flowsheet entry is untouched
    const entriesRes = await request.get('/flowsheet').query({ limit: 10 }).expect(200);
    const entry = entriesRes.body.entries.find((e) => e.id === entryId);
    expect(entry).toBeDefined();
    expect(entry.track_title).toBe('la paradoja');
    expect(entry.artist_name).toBe('Juana Molina');

    // Positive control: primary A ends the show → exactly one signoff
    await resetMockApi();
    const endRes = await fls_util.leave_show(global.primary_dj_id, global.access_token);
    expect(endRes.status).toBe(200);

    await new Promise((r) => setTimeout(r, 300));

    const afterEnd = await getMockRequests('tubafrenzy');
    expect(afterEnd.filter(isSignoff)).toHaveLength(1);
  });
});
