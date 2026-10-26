import { describe, it, expect, jest } from '@jest/globals';

// better-auth/api is stubbed at the jest.unit.config.ts moduleNameMapper
// level (better-auth-api.mock.ts), same as admin-role-write-guard.test.ts.

import {
  CAPABILITY_WRITE_PATHS,
  assertCanAssignCapabilities,
} from '../../../shared/authentication/src/capability-assign-guard';

const UPDATE = '/admin/update-user';
const CREATE = '/admin/create-user';

type Deps = Parameters<typeof assertCanAssignCapabilities>[3];

const depsFor = (memberRole: string | undefined, current: string[] = []) => {
  const selectMemberRole = jest.fn((_userId: string) =>
    Promise.resolve(memberRole === undefined ? undefined : { role: memberRole })
  );
  const readCapabilities = jest.fn((_userId: string) => Promise.resolve(current));
  return { selectMemberRole, readCapabilities } satisfies Deps;
};

const actorWith = (capabilities: string[] = []) => ({ id: 'actor-1', capabilities });

const bodyFor = (path: string, capabilities: unknown) =>
  path === CREATE
    ? { email: 'new@wxyc.org', password: 'pw', name: 'New', data: { capabilities } }
    : { userId: 'dj-1', data: { capabilities } };

describe('assertCanAssignCapabilities', () => {
  // caller role x added capability x route -> allowed / refused. Only a station manager assigns
  // editor, webmaster and reviews_beta; a webmaster-capability holder may also assign editor.
  const table: Array<[string, string, string[], string, boolean]> = [
    ['stationManager', 'editor', [], UPDATE, true],
    ['stationManager', 'webmaster', [], UPDATE, true],
    ['stationManager', 'reviews_beta', [], UPDATE, true],
    ['stationManager', 'editor', [], CREATE, true],
    ['stationManager', 'webmaster', [], CREATE, true],
    ['stationManager', 'reviews_beta', [], CREATE, true],
    ['musicDirector', 'editor', [], UPDATE, false],
    ['musicDirector', 'webmaster', [], UPDATE, false],
    ['musicDirector', 'reviews_beta', [], UPDATE, false],
    ['musicDirector', 'editor', [], CREATE, false],
    ['musicDirector', 'webmaster', [], CREATE, false],
    ['musicDirector', 'reviews_beta', [], CREATE, false],
    ['dj', 'reviews_beta', [], UPDATE, false],
    ['dj', 'reviews_beta', [], CREATE, false],
    ['musicDirector', 'editor', ['webmaster'], UPDATE, true],
    ['musicDirector', 'editor', ['webmaster'], CREATE, true],
    ['musicDirector', 'webmaster', ['webmaster'], CREATE, false],
  ];

  it.each(table)('%s holding %j adding %s via %s -> allowed=%s', async (role, cap, held, path, allowed) => {
    const outcome = assertCanAssignCapabilities(path, bodyFor(path, [cap]), actorWith(held), depsFor(role));
    if (allowed) {
      await expect(outcome).resolves.toBeUndefined();
    } else {
      await expect(outcome).rejects.toMatchObject({
        statusCode: 403,
        body: { code: 'CAPABILITY_ASSIGNMENT_FORBIDDEN' },
      });
    }
  });

  it('refuses a removal the caller could not have granted', async () => {
    await expect(
      assertCanAssignCapabilities(UPDATE, bodyFor(UPDATE, []), actorWith(), depsFor('musicDirector', ['webmaster']))
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('allows a station manager to remove a capability', async () => {
    await expect(
      assertCanAssignCapabilities(UPDATE, bodyFor(UPDATE, []), actorWith(), depsFor('stationManager', ['webmaster']))
    ).resolves.toBeUndefined();
  });

  it('ignores an unchanged capability, so a full-array write that keeps one the caller could not grant passes', async () => {
    await expect(
      assertCanAssignCapabilities(
        UPDATE,
        bodyFor(UPDATE, ['webmaster', 'editor']),
        actorWith(['webmaster']),
        depsFor('musicDirector', ['webmaster'])
      )
    ).resolves.toBeUndefined();
  });

  it.each([
    ['stationManager', [], true],
    ['musicDirector', ['webmaster'], false],
    ['dj', [], false],
  ])(
    'a capability name outside the shared policy (crm_merge): %s holding %j -> allowed=%s',
    async (role, held, allowed) => {
      const outcome = assertCanAssignCapabilities(
        UPDATE,
        bodyFor(UPDATE, ['crm_merge']),
        actorWith(held),
        depsFor(role)
      );
      if (allowed) {
        await expect(outcome).resolves.toBeUndefined();
      } else {
        await expect(outcome).rejects.toMatchObject({ statusCode: 403 });
      }
    }
  );

  it('treats a role that does not canonicalize, or no membership, as unable to assign', async () => {
    for (const role of ['user', undefined]) {
      await expect(
        assertCanAssignCapabilities(CREATE, bodyFor(CREATE, ['editor']), actorWith(), depsFor(role))
      ).rejects.toMatchObject({ statusCode: 403 });
    }
  });

  it('compares create-user against an empty set without reading the database', async () => {
    const deps = depsFor('stationManager', ['editor']);
    await assertCanAssignCapabilities(CREATE, bodyFor(CREATE, ['editor']), actorWith(), deps);
    expect(deps.readCapabilities).not.toHaveBeenCalled();
  });

  it('reads the target user current capabilities for update-user', async () => {
    const deps = depsFor('stationManager', ['editor']);
    await assertCanAssignCapabilities(UPDATE, bodyFor(UPDATE, ['editor']), actorWith(), deps);
    expect(deps.readCapabilities).toHaveBeenCalledWith('dj-1');
  });

  it.each([
    ['capabilities absent from data', UPDATE, { userId: 'dj-1', data: { name: 'x' } }],
    ['no data at all', UPDATE, { userId: 'dj-1' }],
    ['a path outside the capability writers', '/admin/set-role', bodyFor(UPDATE, ['webmaster'])],
  ])('does nothing when %s', async (_name, path, body) => {
    const deps = depsFor('dj');
    await expect(assertCanAssignCapabilities(path, body, actorWith(), deps)).resolves.toBeUndefined();
    expect(deps.selectMemberRole).not.toHaveBeenCalled();
  });

  it('leaves an unauthenticated caller to the plugin own 401', async () => {
    await expect(
      assertCanAssignCapabilities(UPDATE, bodyFor(UPDATE, ['webmaster']), null, depsFor('dj'))
    ).resolves.toBeUndefined();
  });

  it.each([
    ['a string', 'webmaster'],
    ['an object', { webmaster: true }],
    ['a mixed array', ['editor', 7]],
  ])('rejects %s as capabilities with 400', async (_name, value) => {
    await expect(
      assertCanAssignCapabilities(UPDATE, bodyFor(UPDATE, value), actorWith(), depsFor('stationManager'))
    ).rejects.toMatchObject({ statusCode: 400, body: { code: 'CAPABILITIES_MUST_BE_STRING_ARRAY' } });
  });

  it.each([
    ['a one-element array', ['dj-1']],
    ['a number', 123],
    ['an object', { id: 'dj-1' }],
    ['null', null],
    ['an empty string', ''],
    ['missing', undefined],
  ])('refuses update-user with capabilities when userId is %s, with no read', async (_name, userId) => {
    const deps = depsFor('stationManager');
    await expect(
      assertCanAssignCapabilities(UPDATE, { userId, data: { capabilities: ['webmaster'] } }, actorWith(), deps)
    ).rejects.toMatchObject({ statusCode: 400, body: { code: 'USER_ID_MUST_BE_STRING' } });
    expect(deps.readCapabilities).not.toHaveBeenCalled();
    expect(deps.selectMemberRole).not.toHaveBeenCalled();
  });

  it('names exactly the two routes that can write capabilities', () => {
    expect([...CAPABILITY_WRITE_PATHS].sort()).toEqual([CREATE, UPDATE]);
  });
});
