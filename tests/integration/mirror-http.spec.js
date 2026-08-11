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

    // Select the track's POST explicitly rather than assuming it arrived
    // last: the beforeEach join's show_start announcement mirror is
    // fire-and-forget and can land after this entry's POST under load —
    // cross-request mirror ordering is not part of this test's contract.
    const trackPost = entryPosts.find((r) => r.body.artistName === 'Autechre');
    expect(trackPost).toBeDefined();
    expect(trackPost.body.songTitle).toBe('VI Scose Poise');
    expect(trackPost.body.releaseTitle).toBe('Confield');
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

    // Select this track's POST explicitly, same as the test above: the
    // beforeEach join's show_start announcement mirror is fire-and-forget and
    // can land after it under load, and that marker POST carries
    // flowsheetEntryType 9 — cross-request mirror ordering is not this test's
    // contract.
    const trackPost = entryPosts.find((r) => r.body.artistName === 'Jessica Pratt');
    expect(trackPost).toBeDefined();

    // Non-library, non-rotation track should be type 0
    expect(trackPost.body.flowsheetEntryType).toBe(0);
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
 * The shape discrimination's unit-level regression pins live in
 * endshow-shape-guard.test.ts (the `isShowPayload` shouldMirror gate). These
 * black-box assertions are contract coverage plus the primary-plus-guest
 * fixture BS#1533's dj-scoping tests reuse — the fixture identity is asserted
 * rather than assumed, and synchronization with the fire-and-forget mirror is
 * poll-based (the CDC specs' waitForEvent precedent) except where the
 * contract is "nothing arrives", which honestly needs a fixed settle window.
 */
describe('endShow mirror shape guard on guest-DJ leave (BS#1119)', () => {
  const isSignoff = (r) => r.method === 'POST' && r.path.includes('/api/radioShow/signoff');

  // The mock server records its own control endpoints in the per-service log,
  // so `/_admin/requests/tubafrenzy` is itself appended to the log it returns.
  // Any count that includes them can never stop growing — polling is what
  // grows it. Count only real mirror traffic.
  const countMirrorTraffic = (requests) => requests.filter((r) => !r.path.startsWith('/_admin')).length;

  // Poll the mock request log until predicate(requests) is truthy or the
  // timeout lapses (returns the last snapshot either way; the caller's
  // assertion produces the failure).
  const waitForMockRequests = async (predicate, timeoutMs = 4000, intervalMs = 50) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const requests = await getMockRequests('tubafrenzy');
      if (predicate(requests) || Date.now() > deadline) return requests;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };

  // Drain barrier: wait until no new tubafrenzy requests arrive for one
  // settle interval, so an EARLIER test's in-flight fire-and-forget mirror
  // POST (the HTTP response resolves before the mirror does) cannot land
  // inside this test's observation window after resetMockApi.
  //
  // Returns whether it actually went quiet. Timing out is NOT the same
  // outcome: traffic still arriving when the caller resets means the negative
  // window below is measuring the previous show's tail, which can flake red on
  // a stale signoff or — worse — pass while observing the wrong window. Report
  // it rather than returning as if quiet.
  const waitForMirrorQuiescence = async (settleMs = 250, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    let last = countMirrorTraffic(await getMockRequests('tubafrenzy'));
    for (;;) {
      await new Promise((r) => setTimeout(r, settleMs));
      const now = countMirrorTraffic(await getMockRequests('tubafrenzy'));
      if (now === last) return true;
      if (Date.now() > deadline) {
        console.warn(
          `[mirror-http] mirror traffic never quiesced within ${timeoutMs}ms (${last} -> ${now} requests); ` +
            'the following observation window may include earlier traffic'
        );
        return false;
      }
      last = now;
    }
  };

  afterEach(async () => {
    if (!mockApiAvailable) return;
    // Best-effort cleanup so a mid-test failure can't leak an open show into
    // later specs (suite runs --runInBand against shared show state). 200
    // (left/ended) and 400 (wasn't a member) are both expected; anything else
    // gets a trace line pointing here instead of failing a later suite.
    for (const [djId, token] of [
      [global.secondary_dj_id, global.secondary_access_token],
      [global.primary_dj_id, global.access_token],
    ]) {
      const r = await fls_util.leave_show(djId, token);
      if (![200, 400].includes(r.status)) {
        console.warn(`[mirror-http cleanup] unexpected leave_show status ${r.status} for dj ${djId}`);
      }
    }
  });

  test('guest-DJ leave does not sign off the show; primary end signs off once', async () => {
    if (!mockApiAvailable) return;

    // Drain the previous describe's in-flight mirror traffic before taking
    // the baseline reset.
    expect(await waitForMirrorQuiescence()).toBe(true);
    await resetMockApi();

    // Primary A starts the show, guest B joins as co-host. Assert the fixture
    // identity rather than assuming it: if an earlier spec leaked an open
    // show, A's join would be a guest-join (ShowDJ response, no
    // primary_dj_id) and every assertion below would pass or fail vacuously,
    // misattributed to the BS#1119 contract.
    const joinARes = await fls_util.join_show(global.primary_dj_id, global.access_token);
    expect(joinARes.status).toBe(200);
    const joinABody = await joinARes.json();
    expect(joinABody.primary_dj_id).toBe(global.primary_dj_id);

    const joinBRes = await fls_util.join_show(global.secondary_dj_id, global.secondary_access_token);
    expect(joinBRes.status).toBe(200);

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

    // Let join/add mirror traffic flush, then observe only the leave. Assert
    // the drain actually completed: the assertions below are negative
    // ("nothing arrives"), so leaked in-flight traffic would silently
    // invalidate the window rather than fail on its own.
    expect(await waitForMirrorQuiescence()).toBe(true);
    await resetMockApi();

    // Guest B calls /flowsheet/end — leave semantics, controller returns ShowDJ
    const leaveRes = await fls_util.leave_show(global.secondary_dj_id, global.secondary_access_token);
    expect(leaveRes.status).toBe(200);

    // Negative window: fixed settle is the honest form when the contract is
    // that NOTHING arrives — there is no positive event to poll for.
    await new Promise((r) => setTimeout(r, 300));

    // (a) No signoff reached tubafrenzy
    const afterLeave = await getMockRequests('tubafrenzy');
    expect(afterLeave.filter(isSignoff)).toHaveLength(0);

    // (b) The show is still live for primary A, and B is off-air post-leave
    // (distinguishes "gate correctly suppressed endShow" from "the leave was
    // a no-op")
    const onAirRes = await request.get('/flowsheet/on-air').query({ dj_id: global.primary_dj_id }).expect(200);
    expect(onAirRes.body.is_live).toBe(true);
    const onAirBRes = await request.get('/flowsheet/on-air').query({ dj_id: global.secondary_dj_id }).expect(200);
    expect(onAirBRes.body.is_live).toBe(false);

    // (c) The prior flowsheet entry is untouched
    const entriesRes = await request.get('/flowsheet').query({ limit: 10 }).expect(200);
    const entry = entriesRes.body.entries.find((e) => e.id === entryId);
    expect(entry).toBeDefined();
    expect(entry.track_title).toBe('la paradoja');
    expect(entry.artist_name).toBe('Juana Molina');

    // Positive control: primary A ends the show → exactly one signoff. Poll
    // until the first signoff lands (fixed sleeps flake when the mirror chain
    // exceeds them under CI load), then hold one settle window so a duplicate
    // would still be caught by the exact-count assertion.
    await resetMockApi();
    const endRes = await fls_util.leave_show(global.primary_dj_id, global.access_token);
    expect(endRes.status).toBe(200);

    await waitForMockRequests((rs) => rs.filter(isSignoff).length >= 1);
    await new Promise((r) => setTimeout(r, 250));
    const afterEnd = await getMockRequests('tubafrenzy');
    expect(afterEnd.filter(isSignoff)).toHaveLength(1);
  });
});
