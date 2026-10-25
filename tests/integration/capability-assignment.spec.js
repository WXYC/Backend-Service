/**
 * Integration tests for the capability-assignment check (BS#3570) on the
 * better-auth admin plugin routes that can write `auth_user.capabilities`:
 * `/admin/update-user` and `/admin/create-user` (through `data.capabilities`).
 * Driven against the live CI auth service, same idiom as
 * `account-audit-event.spec.js`.
 *
 * The admin plugin only admits users carrying the global `admin` flag, which
 * only station managers get, so a non-manager would be refused by the plugin
 * even without the check. `test_music_director` is therefore given the flag for
 * the duration of this spec: its refusals can only come from the assigner check
 * (a `musicDirector` member role is not in `CAPABILITY_ASSIGNERS`). `test_dj1`
 * keeps no flag and is refused at either layer.
 *
 * Audit rows are written after the response finishes, so row assertions poll.
 */

const { getTestDb } = require('../utils/db');
const { getAuthBaseUrl, signInAs } = require('../utils/account_audit_auth');

const CAPABILITIES = ['editor', 'webmaster', 'reviews_beta'];

async function pollAuditActions(sql, subjectUserId, expected, maxWaitMs = 5000) {
  const startTime = Date.now();
  let actions = [];
  while (Date.now() - startTime < maxWaitMs) {
    const rows = await sql.unsafe(`SELECT action FROM account_audit_event WHERE subject_user_id = $1`, [subjectUserId]);
    actions = rows.map((r) => r.action).sort();
    if (expected.every((a) => actions.includes(a))) return actions;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return actions;
}

describe('capability assignment (BS#3570)', () => {
  const authBaseUrl = getAuthBaseUrl();
  let sql;
  const cookies = {};
  /** @type {string[]} user ids created by these tests; deleted in afterEach. */
  const createdUserIds = [];

  const post = (caller, path, body) =>
    fetch(`${authBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookies[caller] },
      body: JSON.stringify(body),
    });

  const createPayload = (capabilities) => ({
    email: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.wxyc.org`,
    password: 'testpassword123',
    name: 'Capability Test',
    role: 'user',
    data: { capabilities },
  });

  /** Creates a capability-less user as the station manager and returns its id. */
  async function seedTarget() {
    const res = await post('stationManager', '/admin/create-user', createPayload([]));
    if (!res.ok) {
      throw new Error(`seed create-user failed: ${res.status} ${await res.text()}`);
    }
    const id = (await res.json()).user.id;
    createdUserIds.push(id);
    return id;
  }

  const storedCapabilities = async (id) =>
    (await sql.unsafe(`SELECT capabilities FROM auth_user WHERE id = $1`, [id]))[0]?.capabilities;

  beforeAll(async () => {
    sql = getTestDb();
    await sql.unsafe(`UPDATE auth_user SET role = 'admin' WHERE username = 'test_music_director'`);
    cookies.stationManager = (await signInAs(authBaseUrl, 'test_station_manager')).cookie;
    cookies.musicDirector = (await signInAs(authBaseUrl, 'test_music_director')).cookie;
    cookies.dj = (await signInAs(authBaseUrl, 'test_dj1')).cookie;
  });

  afterAll(async () => {
    await sql.unsafe(`UPDATE auth_user SET role = NULL WHERE username = 'test_music_director'`);
  });

  afterEach(async () => {
    if (createdUserIds.length === 0) return;
    await sql.unsafe(`DELETE FROM auth_user WHERE id = ANY($1::text[])`, [createdUserIds.splice(0)]);
  });

  const table = [];
  for (const [caller, allowed] of [
    ['stationManager', true],
    ['musicDirector', false],
    ['dj', false],
  ]) {
    for (const capability of CAPABILITIES) {
      table.push([caller, '/admin/update-user', capability, allowed]);
      table.push([caller, '/admin/create-user', capability, allowed]);
    }
  }

  test.each(table)('%s on %s assigning %s -> allowed=%s', async (caller, route, capability, allowed) => {
    let targetId;
    let res;
    if (route === '/admin/update-user') {
      targetId = await seedTarget();
      res = await post(caller, route, { userId: targetId, data: { capabilities: [capability] } });
    } else {
      const payload = createPayload([capability]);
      res = await post(caller, route, payload);
      if (res.ok) {
        targetId = (await res.json()).user.id;
        createdUserIds.push(targetId);
      }
    }

    if (allowed) {
      expect(res.status).toBe(200);
      expect(await storedCapabilities(targetId)).toEqual([capability]);
    } else {
      expect(res.status).toBe(403);
      if (route === '/admin/update-user') {
        expect(await storedCapabilities(targetId)).toEqual([]);
      }
    }
  });

  test('a refused create-user leaves no user row behind', async () => {
    const payload = createPayload(['webmaster']);
    const res = await post('musicDirector', '/admin/create-user', payload);
    expect(res.status).toBe(403);
    const rows = await sql.unsafe(`SELECT id FROM auth_user WHERE email = $1`, [payload.email.toLowerCase()]);
    expect(rows).toHaveLength(0);
  });

  test('a station manager removing a capability through update-user is allowed and audited as a revoke', async () => {
    const targetId = await seedTarget();
    await post('stationManager', '/admin/update-user', { userId: targetId, data: { capabilities: ['editor'] } });
    const res = await post('stationManager', '/admin/update-user', { userId: targetId, data: { capabilities: [] } });
    expect(res.status).toBe(200);
    expect(await storedCapabilities(targetId)).toEqual([]);
    expect(await pollAuditActions(sql, targetId, ['capability.revoke.editor'])).toContain('capability.revoke.editor');
  });

  test('a music director cannot remove a capability it could not grant', async () => {
    const targetId = await seedTarget();
    await post('stationManager', '/admin/update-user', { userId: targetId, data: { capabilities: ['webmaster'] } });
    const res = await post('musicDirector', '/admin/update-user', { userId: targetId, data: { capabilities: [] } });
    expect(res.status).toBe(403);
    expect(await storedCapabilities(targetId)).toEqual(['webmaster']);
  });

  test('create-user with capabilities writes a capability.grant.<name> row per capability', async () => {
    const res = await post('stationManager', '/admin/create-user', createPayload(['editor', 'reviews_beta']));
    expect(res.status).toBe(200);
    const id = (await res.json()).user.id;
    createdUserIds.push(id);

    const actions = await pollAuditActions(sql, id, ['capability.grant.editor', 'capability.grant.reviews_beta']);
    expect(actions).toEqual(['admin.create-user', 'capability.grant.editor', 'capability.grant.reviews_beta']);
  });

  test('create-user without capabilities writes no capability rows', async () => {
    const id = await seedTarget();
    const actions = await pollAuditActions(sql, id, ['admin.create-user']);
    expect(actions.filter((a) => a.startsWith('capability.'))).toEqual([]);
  });

  test('rejects a non-array capabilities value with 400', async () => {
    const res = await post('stationManager', '/admin/create-user', createPayload('webmaster'));
    expect(res.status).toBe(400);
  });
});
