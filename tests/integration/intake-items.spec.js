/**
 * `/intake` log, list by effective state, get, patch, delete (BS#2796, slice 7
 * of BS#2791).
 *
 * Postgres-backed: direct SQL seeds `intake_items` rows (every one carries the
 * `ITEST-INTAKE` artist prefix, so cleanup is a prefix DELETE that cascades to
 * `intake_item_passes`) and two throwaway `auth_user` rows.
 *
 * THIS TIER CANNOT PIN THE ROLE GRANTS: the CI containers run AUTH_BYPASS=true,
 * under which `requirePermissions` skips its permission block. The grants live
 * in `tests/unit/routes/intake-permissions.route.test.ts`. What this file pins
 * is behavior against real SQL — effective state, the filter built on it, the
 * order, and that a read never writes.
 *
 * Callers: the manager signs in as the seeded `test_station_manager` and sends
 * its JWT, whose `role` claim (from `auth_member`) holds `reviews: manage` — the
 * shared `global.access_token` is a plain DJ (`test_dj1`) in CI and would not.
 * `secondary_access_token` is a raw user-id Bearer that AUTH_BYPASS accepts
 * without a role claim, which is how this tier plays a caller who does not hold
 * `reviews: manage`.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedAuthUser,
  removeSeededAuthUsers,
  seedIntakeItem,
  cdrFormatId,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  seedFormSubmission,
  removeSeededFormSubmissions,
  managerAccessToken,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-INTAKE';
const USER_PREFIX = 'itest-intake-user-';

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe('/intake (BS#2796)', () => {
  let auth;
  let nonManager;
  let sql;
  let formatId;
  let libraryId;
  let citedAlbumId;
  let submissionId;
  const ids = {};

  const seed = async (key, overrides = {}) => {
    const row = {
      artist_name: `${PREFIX} ${key}`,
      album_title: `Album ${key}`,
      // A digital seed leaves the format to the seeder, which stores the CD-R format as POST /intake does.
      ...(!overrides.digital && { format_id: formatId }),
      logged_at: daysAgo(30),
      ...overrides,
    };
    const inserted = await seedIntakeItem(row);
    ids[key] = inserted.id;
    return inserted.id;
  };

  const cleanup = async () => {
    // Keeps its prefix sweep: POST /intake creates items the seeder never saw.
    await sql.unsafe(`DELETE FROM "${SCHEMA}".intake_items WHERE artist_name LIKE $1`, [`${PREFIX}%`]);
    await removeSeededFormSubmissions();
    await removeSeededLibraryReleases();
    await sql.unsafe(`DELETE FROM auth_user WHERE id LIKE $1`, [`${USER_PREFIX}%`]);
    await removeSeededAuthUsers();
  };

  /** This file's rows out of a list response, in the order the endpoint returned them. */
  const mine = (body) => body.filter((i) => i.artist_name.startsWith(PREFIX));
  const keysOf = (body) => mine(body).map((i) => i.artist_name.slice(PREFIX.length + 1));

  beforeAll(async () => {
    auth = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    nonManager = createAuthRequest(request, global.secondary_access_token);
    sql = getTestDb();
    await cleanup();

    [{ id: formatId }] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".format ORDER BY id LIMIT 1`);
    // BS#3052: the names are the staff name, so `real_name` is what shows when it has a value, and `name` when it is null or only whitespace.
    for (const [suffix, name, realName] of [
      ['requested', 'Requested DJ Name', 'Requested Real Name'],
      ['asker', 'Asker DJ Name', 'Asker Real Name'],
      ['asker-plain', 'Asker Plain Name', null],
      ['holder', 'Holder DJ Name', 'Holder Real Name'],
      ['passer', 'Passing DJ Name', 'Passing Real Name'],
      ['null-holder', 'Null Holder DJ Name', null],
      ['blank-holder', 'Blank Holder DJ Name', ' \t\u00a0 '],
    ]) {
      await seedAuthUser({
        id: USER_PREFIX + suffix,
        name,
        email: `${USER_PREFIX}${suffix}@test.wxyc.org`,
        real_name: realName,
      });
    }

    await seed('pool', { logged_at: daysAgo(3) });
    await seed('fresh-request', {
      state: 'requested',
      requested_dj_id: `${USER_PREFIX}requested`,
      requested_by: `${USER_PREFIX}asker`,
      requested_at: daysAgo(1),
      logged_at: daysAgo(4),
    });
    await seed('stale-request', {
      state: 'requested',
      requested_dj_id: `${USER_PREFIX}requested`,
      requested_by: `${USER_PREFIX}asker-plain`,
      requested_at: daysAgo(8),
      logged_at: daysAgo(9),
    });
    await seed('deleted-dj-request', { state: 'requested', requested_dj_id: null, requested_at: daysAgo(1) });
    await seed('overdue', {
      state: 'checked_out',
      checked_out_by: `${USER_PREFIX}holder`,
      checked_out_at: daysAgo(15),
    });
    await seed('recent-checkout', {
      state: 'checked_out',
      checked_out_by: `${USER_PREFIX}holder`,
      checked_out_at: daysAgo(1),
    });
    // Checked out after a request that is now >7 days old (transitions may leave requested_at set).
    await seed('checkout-after-old-request', {
      state: 'checked_out',
      requested_dj_id: `${USER_PREFIX}requested`,
      requested_at: daysAgo(10),
      checked_out_by: `${USER_PREFIX}holder`,
      checked_out_at: daysAgo(2),
    });
    for (const suffix of ['null-holder', 'blank-holder']) {
      await seed(suffix, { state: 'checked_out', checked_out_by: USER_PREFIX + suffix, checked_out_at: daysAgo(1) });
    }
    // No CHECK ties checked_out_at to the state, so the schema admits this row.
    await seed('checkout-no-stamp', { state: 'checked_out', checked_out_by: `${USER_PREFIX}holder` });

    // Two rows with the same logged_at must come back in descending id order.
    const tied = daysAgo(2);
    await seed('tie-first', { logged_at: tied });
    await seed('tie-second', { logged_at: tied });

    await sql`
      INSERT INTO ${sql(SCHEMA)}.intake_item_passes (intake_item_id, dj_id)
      VALUES (${ids.pool}, ${USER_PREFIX + 'passer'})`;

    // A filed item needs a library release (CHECK intake_items_filed_requires_album_ck).
    const filed = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} filed` });
    libraryId = filed.id;
    // A release with a submitted review, and a form submission: the two things an item can cite.
    citedAlbumId = (
      await seedLibraryRelease({ artist_id: filed.artist_id, artist_name: PREFIX, album_title: `${PREFIX} cited` })
    ).id;
    await seedReview({ album_id: citedAlbumId, review: 'A submitted review' });
    submissionId = (
      await seedFormSubmission({ artist_name: PREFIX, album_title: 'Submitted album', review: 'A form review' })
    ).id;
    await seed('filed', { state: 'filed', album_id: libraryId, filed_at: daysAgo(1) });
    await seed('finalized', {
      state: 'finalized',
      album_id: libraryId,
      filed_at: daysAgo(2),
      finalized_at: daysAgo(1),
    });
  });

  afterAll(async () => {
    await cleanup();
  });

  describe('GET /intake', () => {
    test('?state=pool lists a pool item, an expired request and a request whose DJ is gone — but not a live request', async () => {
      const res = await auth.get('/intake').query({ state: 'pool' });
      expect(res.status).toBe(200);
      expect(keysOf(res.body).sort()).toEqual([
        'deleted-dj-request',
        'pool',
        'stale-request',
        'tie-first',
        'tie-second',
      ]);
    });

    test('?state=requested lists only the live request', async () => {
      const res = await auth.get('/intake').query({ state: 'requested' });
      expect(keysOf(res.body)).toEqual(['fresh-request']);
    });

    test('an expired request keeps state: requested and reads effective_state: pool', async () => {
      const res = await auth.get('/intake');
      const stale = mine(res.body).find((i) => i.id === ids['stale-request']);
      expect(stale).toMatchObject({ state: 'requested', effective_state: 'pool', overdue: false });
      const gone = mine(res.body).find((i) => i.id === ids['deleted-dj-request']);
      expect(gone).toMatchObject({ state: 'requested', effective_state: 'pool', requested_dj_id: null });
    });

    test('a read never writes: the expired request row is byte-identical afterwards', async () => {
      const snapshot = () => sql.unsafe(`SELECT * FROM "${SCHEMA}".intake_items WHERE id = $1`, [ids['stale-request']]);
      const before = await snapshot();
      await auth.get('/intake');
      await auth.get('/intake').query({ state: 'pool' });
      await auth.get(`/intake/${ids['stale-request']}`);
      expect(await snapshot()).toEqual(before);
      expect(before[0].state).toBe('requested');
      expect(before[0].requested_dj_id).toBe(`${USER_PREFIX}requested`);
    });

    test('overdue is true only for a checked_out item older than 14 days, and state is untouched', async () => {
      const res = await auth.get('/intake').query({ state: 'checked_out' });
      const byKey = Object.fromEntries(mine(res.body).map((i) => [i.artist_name.slice(PREFIX.length + 1), i]));
      expect(byKey.overdue).toMatchObject({ state: 'checked_out', effective_state: 'checked_out', overdue: true });
      expect(byKey['recent-checkout']).toMatchObject({ overdue: false });
    });

    test('a checked_out item with an old requested_at stays checked_out — the expiry arms only apply to requested', async () => {
      const res = await auth.get('/intake').query({ state: 'checked_out' });
      const item = mine(res.body).find((i) => i.id === ids['checkout-after-old-request']);
      expect(item).toMatchObject({ state: 'checked_out', effective_state: 'checked_out' });
    });

    test('a checked_out item with no checked_out_at reads overdue: false, not null', async () => {
      const res = await auth.get(`/intake/${ids['checkout-no-stamp']}`);
      expect(res.status).toBe(200);
      expect(res.body.overdue).toBe(false);
    });

    test('orders by logged_at DESC, id DESC — equal timestamps come back highest id first', async () => {
      const res = await auth.get('/intake');
      const keys = keysOf(res.body);
      expect(keys.indexOf('tie-second')).toBeLessThan(keys.indexOf('tie-first'));
      const stamps = mine(res.body).map((i) => Date.parse(i.logged_at));
      expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
    });

    test('names are the real name when the account has one (BS#3052)', async () => {
      const res = await auth.get('/intake');
      const fresh = mine(res.body).find((i) => i.id === ids['fresh-request']);
      expect(fresh.requested_dj_name).toBe('Requested Real Name');
      const overdue = mine(res.body).find((i) => i.id === ids.overdue);
      expect(overdue.checked_out_by_name).toBe('Holder Real Name');
    });

    test.each([
      ['null', 'null-holder', 'Null Holder DJ Name'],
      ['only whitespace', 'blank-holder', 'Blank Holder DJ Name'],
    ])('a holder whose real_name is %s is named by auth_user.name (BS#3052)', async (_case, key, expected) => {
      const res = await auth.get('/intake');
      expect(mine(res.body).find((i) => i.id === ids[key]).checked_out_by_name).toBe(expected);
    });

    test.each([
      ['the real name when the asker has one', 'fresh-request', `${USER_PREFIX}asker`, 'Asker Real Name'],
      [
        'the account name when the asker has no real name',
        'stale-request',
        `${USER_PREFIX}asker-plain`,
        'Asker Plain Name',
      ],
      ['null when no account asked', 'deleted-dj-request', null, null],
    ])('requested_by_name is %s', async (_case, key, askerId, expected) => {
      const res = await auth.get(`/intake/${ids[key]}`);
      expect(res.body.requested_by).toBe(askerId);
      expect(res.body.requested_by_name).toBe(expected);
    });

    test('a request whose DJ account is gone still has a null requested_dj_name (BS#3052)', async () => {
      const res = await auth.get(`/intake/${ids['deleted-dj-request']}`);
      expect(res.body.requested_dj_name).toBeNull();
    });

    test("a caller holding reviews:manage sees passes on list items (the passing DJ's real name, and their account id)", async () => {
      const res = await auth.get('/intake');
      const pooled = mine(res.body).find((i) => i.id === ids.pool);
      expect(pooled.passes).toEqual([
        { dj_name: 'Passing Real Name', passed_at: expect.any(String), dj_id: `${USER_PREFIX}passer` },
      ]);
      const unpassed = mine(res.body).find((i) => i.id === ids['tie-first']);
      expect(unpassed.passes).toEqual([]);
    });

    test('a caller without reviews:manage never sees passes', async () => {
      const res = await nonManager.get('/intake');
      expect(res.status).toBe(200);
      mine(res.body).forEach((i) => expect(i).not.toHaveProperty('passes'));
      expect(res.text).not.toMatch(/Passing (DJ|Real) Name/);
    });

    describe('limit, active and filing-time order (BS#3092)', () => {
      // Minutes ago, so these rank ahead of the daysAgo() filed rows seeded above and any limit lands on them.
      const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();
      const filedRow = (filed_at, extra = {}) => ({
        state: 'filed',
        album_id: libraryId,
        filed_at,
        // logged_at runs the other way from filed_at, so the two orderings cannot agree by accident.
        ...extra,
      });

      beforeAll(async () => {
        await seed('filed-new', filedRow(minutesAgo(10), { logged_at: daysAgo(40) }));
        await seed('filed-mid', filedRow(minutesAgo(20), { logged_at: daysAgo(35) }));
        await seed('filed-old', filedRow(minutesAgo(30), { logged_at: daysAgo(5) }));
        // One shared filed_at, and the higher id logged earlier: id descending (tie-b first) agrees with neither insertion order nor logged_at descending (both tie-a first).
        const tiedFiledAt = minutesAgo(40);
        await seed('filed-tie-a', filedRow(tiedFiledAt, { logged_at: daysAgo(10) }));
        await seed('filed-tie-b', filedRow(tiedFiledAt, { logged_at: daysAgo(20) }));
        await seed('filed-undated', filedRow(null, { logged_at: daysAgo(1) }));
        // Filed most recently, but logged earliest and with the lower id; finalized-b is filed earlier, logged later, with the higher id. filed_at order is a, b, 'finalized'; logged_at order is b, 'finalized', a; id order is b, a, 'finalized'.
        await seed('finalized-a', {
          state: 'finalized',
          album_id: libraryId,
          filed_at: minutesAgo(5),
          finalized_at: minutesAgo(4),
          logged_at: daysAgo(50),
        });
        await seed('finalized-b', {
          state: 'finalized',
          album_id: libraryId,
          filed_at: minutesAgo(15),
          finalized_at: minutesAgo(14),
          logged_at: daysAgo(3),
        });
        await seed('reviewed', { state: 'reviewed', logged_at: daysAgo(6) });
        await seedReview({ intake_item_id: ids['reviewed'], review: 'A submitted review' });
      });

      const FILED_ORDER = ['filed-new', 'filed-mid', 'filed-old', 'filed-tie-b', 'filed-tie-a'];

      test('?state=filed&limit=2 returns the two most recently filed, newest first, whatever the logged_at order', async () => {
        const res = await auth.get('/intake').query({ state: 'filed', limit: 2 });
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
        expect(keysOf(res.body)).toEqual(['filed-new', 'filed-mid']);
      });

      test('?state=filed with no limit returns every filed item by filed_at descending, ties by id descending', async () => {
        const res = await auth.get('/intake').query({ state: 'filed' });
        expect(res.status).toBe(200);
        const keys = keysOf(res.body);
        expect(keys.filter((k) => FILED_ORDER.includes(k))).toEqual(FILED_ORDER);
        expect(keys).toContain('filed');
        expect(keys.indexOf('filed')).toBeGreaterThan(keys.indexOf('filed-tie-a'));
      });

      test('?state=finalized is ordered by filed_at descending too, whatever the logged_at and id order', async () => {
        const res = await auth.get('/intake').query({ state: 'finalized' });
        expect(res.status).toBe(200);
        expect(keysOf(res.body)).toEqual(['finalized-a', 'finalized-b', 'finalized']);
      });

      test('a filed item with a null filed_at sorts after every dated one', async () => {
        // The NULLS LAST clause itself is pinned in the unit SQL test; a limited read cannot be scoped to this file's rows, so only the unlimited list is asserted here.
        const res = await auth.get('/intake').query({ state: 'filed' });
        expect(res.status).toBe(200);
        const firstNull = res.body.findIndex((i) => i.filed_at === null);
        expect(res.body.slice(0, firstNull).every((i) => i.filed_at !== null)).toBe(true);
        expect(res.body.slice(firstNull).every((i) => i.filed_at === null)).toBe(true);
        expect(res.body.map((i) => i.id)).toContain(ids['filed-undated']);
        expect(res.body.findIndex((i) => i.id === ids['filed-undated'])).toBeGreaterThanOrEqual(firstNull);
      });

      test('?limit=2 with no state returns the two most recently logged items', async () => {
        const res = await auth.get('/intake').query({ limit: 2 });
        expect(res.status).toBe(200);
        const all = await auth.get('/intake');
        expect(res.body.map((i) => i.id)).toEqual(all.body.slice(0, 2).map((i) => i.id));
      });

      test('?active=true drops filed and finalized items and keeps every other state, a stale request included', async () => {
        const res = await auth.get('/intake').query({ active: 'true' });
        expect(res.status).toBe(200);
        const keys = keysOf(res.body);
        expect(keys).toEqual(expect.arrayContaining(['pool', 'fresh-request', 'stale-request', 'overdue', 'reviewed']));
        mine(res.body).forEach((i) => expect(['filed', 'finalized']).not.toContain(i.effective_state));
        expect(keys).not.toContain('filed');
        expect(keys).not.toContain('finalized');
      });

      test('?active=false is the same as no parameter', async () => {
        const [withFalse, without] = [await auth.get('/intake').query({ active: 'false' }), await auth.get('/intake')];
        expect(withFalse.status).toBe(200);
        expect(withFalse.body.map((i) => i.id)).toEqual(without.body.map((i) => i.id));
      });

      test('?active=true&state=filed is an empty list, not a 400', async () => {
        const res = await auth.get('/intake').query({ active: 'true', state: 'filed' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
      });

      test('?active=true&awaiting_acceptance=true returns only items satisfying both', async () => {
        const res = await auth.get('/intake').query({ active: 'true', awaiting_acceptance: 'true' });
        expect(res.status).toBe(200);
        expect(keysOf(res.body)).toEqual(['reviewed']);
        const alone = await auth.get('/intake').query({ awaiting_acceptance: 'true' });
        expect(keysOf(alone.body)).toContain('reviewed');
      });

      test.each([
        ['limit=0', { limit: '0' }],
        ['limit=101', { limit: '101' }],
        ['limit=abc', { limit: 'abc' }],
        ['active=maybe', { active: 'maybe' }],
      ])('?%s is a 400', async (_case, query) => {
        const res = await auth.get('/intake').query(query);
        expect(res.status).toBe(400);
      });
    });

    test('?state=bogus is a 400', async () => {
      const res = await auth.get('/intake').query({ state: 'bogus' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/^Invalid Parameter: state must be one of pool, requested/);
    });
  });

  describe('GET /intake/:id', () => {
    test('returns the item with passes for a manager, without for others', async () => {
      const managed = await auth.get(`/intake/${ids.pool}`);
      expect(managed.status).toBe(200);
      expect(managed.body.passes).toHaveLength(1);
      const other = await nonManager.get(`/intake/${ids.pool}`);
      expect(other.status).toBe(200);
      expect(other.body).not.toHaveProperty('passes');
    });

    test('404 for a missing item', async () => {
      expect((await auth.get('/intake/2147483000')).status).toBe(404);
    });
  });

  describe('POST, PATCH, DELETE', () => {
    test('POST logs an item in pool, stamping logged_by and logged_at; PATCH edits it; DELETE removes it', async () => {
      const created = await auth.post('/intake').send({
        artist_name: `${PREFIX} crud`,
        album_title: ' Edits ',
        record_label: ' Self-released ',
        format_id: formatId,
      });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({
        state: 'pool',
        effective_state: 'pool',
        album_title: 'Edits',
        record_label: 'Self-released',
      });
      const [row] = await sql.unsafe(`SELECT logged_by, logged_at FROM "${SCHEMA}".intake_items WHERE id = $1`, [
        created.body.id,
      ]);
      expect(row.logged_by).toBeTruthy();
      expect(row.logged_at).toBeInstanceOf(Date);

      const patched = await auth
        .patch(`/intake/${created.body.id}`)
        .send({ album_title: 'Edits (2)', record_label: null });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ album_title: 'Edits (2)', record_label: null });

      const deleted = await auth.delete(`/intake/${created.body.id}`);
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({ deleted_review_authors: [] });
      expect((await auth.get(`/intake/${created.body.id}`)).status).toBe(404);
    });

    test.each([
      ['an unknown format_id', { format_id: 2147483000 }],
      ['a discogs_release_id past int4', { discogs_release_id: 2147483648 }],
    ])('POST with %s is a 400, not a 500', async (_name, extra) => {
      const res = await auth
        .post('/intake')
        .send({ artist_name: `${PREFIX} bad`, album_title: 'x', format_id: formatId, ...extra });
      expect(res.status).toBe(400);
    });

    describe('listen-first links (BS#3390)', () => {
      const linkRow = async (id) =>
        (
          await sql.unsafe(
            `SELECT spotify_url, apple_music_url, bandcamp_url, bandcamp_url_entered, links_checked_at FROM "${SCHEMA}".intake_items WHERE id = $1`,
            [id]
          )
        )[0];
      const countMine = async () =>
        Number(
          (
            await sql.unsafe(`SELECT count(*) FROM "${SCHEMA}".intake_items WHERE artist_name = $1`, [
              `${PREFIX} links`,
            ])
          )[0].count
        );
      const body = (extra) => ({ artist_name: `${PREFIX} links`, album_title: 'Links', format_id: formatId, ...extra });

      test.each([
        ['a label subdomain', 'https://label.bandcamp.com/album/x'],
        ['the bare host', 'https://bandcamp.com/juana-molina'],
      ])('POST stores %s and marks it entered; the read returns it and never the flag', async (_name, url) => {
        const created = await auth.post('/intake').send(body({ bandcamp_url: url }));
        expect(created.status).toBe(200);
        expect(created.body).toMatchObject({ bandcamp_url: url, spotify_url: null, apple_music_url: null });
        expect(created.body).not.toHaveProperty('bandcamp_url_entered');
        expect(created.body).not.toHaveProperty('links_checked_at');
        expect(await linkRow(created.body.id)).toMatchObject({ bandcamp_url: url, bandcamp_url_entered: true });
        const read = await auth.get(`/intake/${created.body.id}`);
        expect(read.body.bandcamp_url).toBe(url);
      });

      test('an item added without links reads three nulls and an unset flag', async () => {
        const created = await auth.post('/intake').send(body({}));
        expect(created.body).toMatchObject({ spotify_url: null, apple_music_url: null, bandcamp_url: null });
        expect(await linkRow(created.body.id)).toMatchObject({ bandcamp_url_entered: false, links_checked_at: null });
      });

      test.each([
        ['plain http', 'http://label.bandcamp.com/album/x'],
        ['another host with bandcamp.com in the path', 'https://evil.com/bandcamp.com'],
        ['bandcamp.com as a prefix of another host', 'https://bandcamp.com.evil.com'],
        ['a non-URL', 'not a link'],
        ['more than 512 characters', `https://label.bandcamp.com/${'a'.repeat(512)}`],
      ])('POST refuses %s with a 400 and writes nothing', async (_name, url) => {
        const before = await countMine();
        const res = await auth.post('/intake').send(body({ bandcamp_url: url }));
        expect(res.status).toBe(400);
        expect(await countMine()).toBe(before);
      });

      test('PATCH enters a link, a refused link leaves the stored one, and null or a blank string clears link and flag', async () => {
        const id = (await auth.post('/intake').send(body({}))).body.id;
        const url = 'https://label.bandcamp.com/album/x';

        expect((await auth.patch(`/intake/${id}`).send({ bandcamp_url: url })).body.bandcamp_url).toBe(url);
        expect(await linkRow(id)).toMatchObject({ bandcamp_url: url, bandcamp_url_entered: true });

        expect((await auth.patch(`/intake/${id}`).send({ bandcamp_url: 'http://evil.com/x' })).status).toBe(400);
        expect(await linkRow(id)).toMatchObject({ bandcamp_url: url, bandcamp_url_entered: true });

        for (const cleared of [null, '  ']) {
          await auth.patch(`/intake/${id}`).send({ bandcamp_url: url });
          const res = await auth.patch(`/intake/${id}`).send({ bandcamp_url: cleared });
          expect(res.status).toBe(200);
          expect(res.body.bandcamp_url).toBeNull();
          expect(await linkRow(id)).toMatchObject({ bandcamp_url: null, bandcamp_url_entered: false });
        }
      });

      test('a PATCH that does not carry the key leaves the link and the flag alone', async () => {
        const url = 'https://label.bandcamp.com/album/x';
        const id = (await auth.post('/intake').send(body({ bandcamp_url: url }))).body.id;
        await auth.patch(`/intake/${id}`).send({ album_title: 'Links (2)' });
        expect(await linkRow(id)).toMatchObject({ bandcamp_url: url, bandcamp_url_entered: true });
      });
    });

    describe('digital albums (BS#3100)', () => {
      const rowOf = async (id) => (await sql.unsafe(`SELECT * FROM "${SCHEMA}".intake_items WHERE id = $1`, [id]))[0];
      const countMine = async () =>
        Number(
          (
            await sql.unsafe(`SELECT count(*) FROM "${SCHEMA}".intake_items WHERE artist_name = $1`, [
              `${PREFIX} digital`,
            ])
          )[0].count
        );
      const body = (extra) => ({ artist_name: `${PREFIX} digital`, album_title: 'Files', ...extra });

      test.each([
        ['digital with no format_id stores the CD-R format', { digital: true }, 200, { digital: true, cdr: true }],
        ['digital with a format_id', { digital: true, format_id: 1 }, 400, null],
        ['neither digital nor format_id', {}, 400, null],
        ['digital: false with no format_id', { digital: false }, 400, null],
        [
          'digital: false with a format_id behaves as before',
          { digital: false, format_id: 1 },
          200,
          { digital: false },
        ],
        ['a non-boolean digital', { digital: 'yes' }, 400, null],
      ])('POST: %s', async (_name, extra, status, stored) => {
        const before = await countMine();
        const res = await auth.post('/intake').send(body(extra));
        expect(res.status).toBe(status);
        if (!stored) return expect(await countMine()).toBe(before);
        expect(res.body.digital).toBe(stored.digital);
        const row = await rowOf(res.body.id);
        expect(row.digital).toBe(stored.digital);
        expect(row.format_id).toBe(stored.cdr ? await cdrFormatId() : 1);
      });

      test('POST digital with no cdr format row is a 409 ApiErrorResponse and writes nothing', async () => {
        // Every row the lookup would match is renamed, so every one is restored: the ids come back from the UPDATE itself.
        const renamed = (
          await sql`UPDATE ${sql(SCHEMA)}.format SET format_name = format_name || '-renamed' WHERE lower(format_name) = 'cdr' RETURNING id`
        ).map((row) => row.id);
        expect(renamed.length).toBeGreaterThan(0);
        try {
          const before = await countMine();
          const res = await auth.post('/intake').send(body({ digital: true }));
          expect(res.status).toBe(409);
          expect(res.body).toMatchObject({ code: 'no_cdr_format' });
          expect(typeof res.body.message).toBe('string');
          expect(await countMine()).toBe(before);
        } finally {
          await sql`UPDATE ${sql(SCHEMA)}.format SET format_name = regexp_replace(format_name, '-renamed$', '') WHERE id = ANY(${renamed})`;
        }
      });

      test('GET /intake and GET /intake/:id return digital, true and false', async () => {
        const digital = (await auth.post('/intake').send(body({ digital: true }))).body;
        const disc = ids.pool;
        expect((await auth.get(`/intake/${digital.id}`)).body.digital).toBe(true);
        expect((await auth.get(`/intake/${disc}`)).body.digital).toBe(false);
        const list = mine(await auth.get('/intake').then((r) => r.body));
        expect(list.find((i) => i.id === digital.id).digital).toBe(true);
        expect(list.find((i) => i.id === disc).digital).toBe(false);
      });

      test('PATCH with format_id on a digital item is a 400 and changes nothing; on a disc item it applies', async () => {
        const digitalId = await seed('digital-patch', { digital: true, format_id: await cdrFormatId() });
        const before = await rowOf(digitalId);
        const refused = await auth.patch(`/intake/${digitalId}`).send({ album_title: 'Changed', format_id: formatId });
        expect(refused.status).toBe(400);
        expect(await rowOf(digitalId)).toEqual(before);
        expect((await auth.patch(`/intake/${digitalId}`).send({ album_title: 'Changed' })).status).toBe(200);

        // A format other than the one the item holds, so a PATCH that dropped `format_id` for disc items would leave the stored value as it was.
        const [{ id: otherFormatId }] = await sql.unsafe(
          `SELECT id FROM "${SCHEMA}".format WHERE id <> $1 ORDER BY id LIMIT 1`,
          [formatId]
        );
        const discId = await seed('disc-patch');
        const applied = await auth.patch(`/intake/${discId}`).send({ format_id: otherFormatId });
        expect(applied.status).toBe(200);
        expect(applied.body.format_id).toBe(otherFormatId);
        expect((await rowOf(discId)).format_id).toBe(otherFormatId);
      });
    });

    // REVIEW_GATE_CUTOVER_DATE is deliberately unset here (setting it would break every spec that creates releases, BS#2807): any existing release or submission is citable. The cutover-date arms are pinned in the unit tier.
    describe('PATCH citations (BS#2797), cutover unset', () => {
      const citationsOf = async (id) =>
        (
          await sql.unsafe(`SELECT cited_album_id, cited_submission_id FROM "${SCHEMA}".intake_items WHERE id = $1`, [
            id,
          ])
        )[0];

      test('citing an existing release with a submitted review is a 200 that stores the citation', async () => {
        const id = await seed('cite-release');
        const res = await auth.patch(`/intake/${id}`).send({ cited_album_id: citedAlbumId });
        expect(res.status).toBe(200);
        expect(res.body.cited_album_id).toBe(citedAlbumId);
        expect(await citationsOf(id)).toEqual({ cited_album_id: citedAlbumId, cited_submission_id: null });
      });

      test('citing an existing release with no review row is a 200 (pre-cutover releases are deemed reviewed)', async () => {
        const id = await seed('cite-unreviewed');
        const res = await auth.patch(`/intake/${id}`).send({ cited_album_id: libraryId });
        expect(res.status).toBe(200);
        expect(await citationsOf(id)).toEqual({ cited_album_id: libraryId, cited_submission_id: null });
      });

      test('citing an existing form submission is a 200', async () => {
        const id = await seed('cite-submission');
        const res = await auth.patch(`/intake/${id}`).send({ cited_submission_id: submissionId });
        expect(res.status).toBe(200);
        expect(await citationsOf(id)).toEqual({ cited_album_id: null, cited_submission_id: submissionId });
      });

      test.each([
        ['a nonexistent release', { cited_album_id: 2147483000 }],
        ['a nonexistent submission', { cited_submission_id: 2147483000 }],
      ])('citing %s is a 409 invalid_citation and changes nothing', async (_name, body) => {
        const id = await seed('cite-bad');
        const res = await auth.patch(`/intake/${id}`).send({ ...body, album_title: 'Changed' });
        expect(res.status).toBe(409);
        expect(res.body.reason).toBe('invalid_citation');
        const [row] = await sql.unsafe(`SELECT album_title FROM "${SCHEMA}".intake_items WHERE id = $1`, [id]);
        expect(row.album_title).toBe('Album cite-bad');
      });

      test('setting one citation clears the other in the same request, in both directions', async () => {
        const id = await seed('cite-switch');
        await auth.patch(`/intake/${id}`).send({ cited_album_id: citedAlbumId });
        const toSubmission = await auth.patch(`/intake/${id}`).send({ cited_submission_id: submissionId });
        expect(toSubmission.status).toBe(200);
        expect(await citationsOf(id)).toEqual({ cited_album_id: null, cited_submission_id: submissionId });
        const toRelease = await auth.patch(`/intake/${id}`).send({ cited_album_id: citedAlbumId });
        expect(toRelease.status).toBe(200);
        expect(await citationsOf(id)).toEqual({ cited_album_id: citedAlbumId, cited_submission_id: null });
      });

      test('an explicit null clears a citation, and both non-null is a 400', async () => {
        const id = await seed('cite-clear', { cited_album_id: citedAlbumId });
        const both = await auth
          .patch(`/intake/${id}`)
          .send({ cited_album_id: citedAlbumId, cited_submission_id: submissionId });
        expect(both.status).toBe(400);
        const cleared = await auth.patch(`/intake/${id}`).send({ cited_album_id: null });
        expect(cleared.status).toBe(200);
        expect(await citationsOf(id)).toEqual({ cited_album_id: null, cited_submission_id: null });
      });

      test.each(['filed', 'finalized'])(
        'citing on a %s item is a 409 already_filed, even for a valid citation',
        async (key) => {
          const res = await auth.patch(`/intake/${ids[key]}`).send({ cited_album_id: citedAlbumId });
          expect(res.status).toBe(409);
          expect(res.body.reason).toBe('already_filed');
          const bad = await auth.patch(`/intake/${ids[key]}`).send({ cited_album_id: 2147483000 });
          expect(bad.status).toBe(409);
          expect(bad.body.reason).toBe('already_filed');
        }
      );

      // Setting a citation withdraws a pending request in the same UPDATE (BS#3383, decision 10 of the 2026-10-16 review-screen UX review); clearing one, or citing on any other state, leaves the request fields alone.
      const requester = `${USER_PREFIX}requested`;
      const holder = `${USER_PREFIX}holder`;
      const requestFieldsOf = async (id) =>
        (
          await sql.unsafe(
            `SELECT state, requested_dj_id, requested_at, requested_by, checked_out_by, cited_album_id, cited_submission_id FROM "${SCHEMA}".intake_items WHERE id = $1`,
            [id]
          )
        )[0];
      // Resolved at test time: the cited ids are seeded in beforeAll.
      const citing = () => ({
        album: {
          patch: { cited_album_id: citedAlbumId },
          after: { cited_album_id: citedAlbumId, cited_submission_id: null },
        },
        submission: {
          patch: { cited_submission_id: submissionId },
          after: { cited_album_id: null, cited_submission_id: submissionId },
        },
        clear: { patch: { cited_album_id: null }, after: { cited_album_id: null, cited_submission_id: null } },
      });
      const asker = `${USER_PREFIX}asker`;
      const pending = { state: 'requested', requested_dj_id: requester, requested_by: asker, requested_at: daysAgo(1) };
      const withdrawn = {
        state: 'pool',
        requested_dj_id: null,
        requested_at: null,
        requested_by: null,
        checked_out_by: null,
      };
      const kept = {
        state: 'requested',
        requested_dj_id: requester,
        requested_by: asker,
        requested_at: expect.any(Date),
        checked_out_by: null,
      };

      test.each([
        ['citing a release withdraws a request', pending, 'album', withdrawn],
        ['citing a form review withdraws a request', pending, 'submission', withdrawn],
        ['citing withdraws a lapsed request', { ...pending, requested_at: daysAgo(8) }, 'album', withdrawn],
        [
          'citing withdraws a request whose DJ account is gone',
          { ...pending, requested_dj_id: null },
          'album',
          withdrawn,
        ],
        [
          'citing keeps the holder of a checked_out item and its leftover request',
          {
            state: 'checked_out',
            checked_out_by: holder,
            checked_out_at: daysAgo(1),
            requested_dj_id: requester,
            requested_by: asker,
            requested_at: daysAgo(10),
          },
          'album',
          {
            state: 'checked_out',
            requested_dj_id: requester,
            requested_by: asker,
            requested_at: expect.any(Date),
            checked_out_by: holder,
          },
        ],
        ['citing on a pool item changes only the citation', { state: 'pool' }, 'album', withdrawn],
        ['clearing a citation keeps the request', pending, 'clear', kept],
      ])('%s', async (name, overrides, how, expected) => {
        const { patch, after } = citing()[how];
        const id = await seed(
          `cite-withdraw ${name}`,
          how === 'clear' ? { ...overrides, cited_album_id: citedAlbumId } : overrides
        );
        const res = await auth.patch(`/intake/${id}`).send(patch);
        expect(res.status).toBe(200);
        expect(await requestFieldsOf(id)).toMatchObject({ ...expected, ...after });
      });

      test('citing on a missing item is a 404', async () => {
        expect((await auth.patch('/intake/2147483000').send({ cited_album_id: citedAlbumId })).status).toBe(404);
      });
    });

    test.each(['filed', 'finalized'])(
      'PATCH and DELETE of a %s item are 409 already_filed and change nothing',
      async (key) => {
        const patch = await auth.patch(`/intake/${ids[key]}`).send({ album_title: 'Nope' });
        expect(patch.status).toBe(409);
        expect(patch.body.reason).toBe('already_filed');
        const del = await auth.delete(`/intake/${ids[key]}`);
        expect(del.status).toBe(409);
        expect(del.body.reason).toBe('already_filed');
        const [row] = await sql.unsafe(`SELECT album_title FROM "${SCHEMA}".intake_items WHERE id = $1`, [ids[key]]);
        expect(row.album_title).toBe(`Album ${key}`);
      }
    );

    test('PATCH and DELETE of a missing item are 404', async () => {
      expect((await auth.patch('/intake/2147483000').send({ album_title: 'x' })).status).toBe(404);
      expect((await auth.delete('/intake/2147483000')).status).toBe(404);
    });
  });
});
