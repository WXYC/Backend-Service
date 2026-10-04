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
const { seedAuthUser, removeSeededAuthUsers, seedIntakeItem, managerAccessToken } = require('../utils/intake_seed');

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
      format_id: formatId,
      logged_at: daysAgo(30),
      ...overrides,
    };
    const inserted = await seedIntakeItem(row);
    ids[key] = inserted.id;
    return inserted.id;
  };

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".intake_items WHERE artist_name LIKE $1`, [`${PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".album_review_submissions WHERE artist_name = $1`, [PREFIX]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE album_title LIKE $1`, [`${PREFIX} %`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".artists WHERE artist_name = $1 AND code_letters = 'ZZ'`, [PREFIX]);
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
    // `real_name` is seeded with a marker so a leak anywhere in a response is a failed assertion.
    for (const [suffix, name] of [
      ['requested', 'Requested DJ Name'],
      ['holder', 'Holder DJ Name'],
      ['passer', 'Passing DJ Name'],
    ]) {
      await seedAuthUser({
        id: USER_PREFIX + suffix,
        name,
        email: `${USER_PREFIX}${suffix}@test.wxyc.org`,
        real_name: 'LEAKED REAL NAME',
      });
    }

    await seed('pool', { logged_at: daysAgo(3) });
    await seed('fresh-request', {
      state: 'requested',
      requested_dj_id: `${USER_PREFIX}requested`,
      requested_at: daysAgo(1),
      logged_at: daysAgo(4),
    });
    await seed('stale-request', {
      state: 'requested',
      requested_dj_id: `${USER_PREFIX}requested`,
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
    const [genre] = await sql.unsafe(`SELECT id FROM "${SCHEMA}".genres ORDER BY id LIMIT 1`);
    const [artist] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".artists (artist_name, alphabetical_name, code_letters) VALUES ($1, $1, 'ZZ') RETURNING id`,
      [PREFIX]
    );
    const [lib] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, $4, 9102, $5) RETURNING id`,
      [artist.id, genre.id, formatId, `${PREFIX} filed`, PREFIX]
    );
    libraryId = lib.id;
    // A release with a submitted review, and a form submission: the two things an item can cite.
    const [cited] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES ($1, $2, $3, $4, 9103, $5) RETURNING id`,
      [artist.id, genre.id, formatId, `${PREFIX} cited`, PREFIX]
    );
    citedAlbumId = cited.id;
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".reviews (album_id, review, author, status) VALUES ($1, $2, $3, 'submitted')`,
      [citedAlbumId, 'A submitted review', PREFIX]
    );
    [{ id: submissionId }] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".album_review_submissions (artist_name, album_title, review) VALUES ($1, $2, $3) RETURNING id`,
      [PREFIX, 'Submitted album', 'A form review']
    );
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

    test('names come from auth_user.name; real_name never appears', async () => {
      const res = await auth.get('/intake');
      const fresh = mine(res.body).find((i) => i.id === ids['fresh-request']);
      expect(fresh.requested_dj_name).toBe('Requested DJ Name');
      const overdue = mine(res.body).find((i) => i.id === ids.overdue);
      expect(overdue.checked_out_by_name).toBe('Holder DJ Name');
      expect(res.text).not.toContain('LEAKED REAL NAME');
    });

    test('a caller holding reviews:manage sees passes on list items (name from auth_user.name)', async () => {
      const res = await auth.get('/intake');
      const pooled = mine(res.body).find((i) => i.id === ids.pool);
      expect(pooled.passes).toEqual([{ dj_name: 'Passing DJ Name', passed_at: expect.any(String) }]);
      const unpassed = mine(res.body).find((i) => i.id === ids['tie-first']);
      expect(unpassed.passes).toEqual([]);
    });

    test('a caller without reviews:manage never sees passes', async () => {
      const res = await nonManager.get('/intake');
      expect(res.status).toBe(200);
      mine(res.body).forEach((i) => expect(i).not.toHaveProperty('passes'));
      expect(res.text).not.toContain('Passing DJ Name');
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
