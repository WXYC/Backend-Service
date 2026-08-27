/**
 * Characterization tests for the admin-flag sync extracted out of the
 * `organizationHooks` literal. These pin the behavior as it was BEFORE the
 * extraction — the existing suite cannot, since every other unit test against
 * `auth.definition.ts` is a source-scan that never executes this code.
 *
 * `auth.roles.ts` is reached through `better-auth/plugins/access` and
 * `.../organization/access`, both stubbed at the jest.unit.config.ts
 * moduleNameMapper level.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import {
  grantsAdminFlag,
  syncAdminFlagOnAddMember,
  syncAdminFlagOnRemoveMember,
  syncAdminFlagOnUpdateMemberRole,
} from '../../../shared/authentication/src/admin-flag-sync';

const ORG = 'wxyc';
const USER = { id: 'u1', email: 'dj@wxyc.org' };

/** Roles that carry stationManager authority, and therefore the admin flag. */
const ADMIN_GRANTING = ['stationManager', 'admin', 'owner'];
const NON_ADMIN_GRANTING = ['member', 'dj', 'musicDirector'];

describe('admin flag sync', () => {
  let setUserRole: jest.Mock<(userId: string, role: 'admin' | null) => Promise<void>>;
  let onError: jest.Mock<(error: unknown) => void>;
  let warn: jest.SpiedFunction<typeof console.warn>;
  let log: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    setUserRole = jest.fn(() => Promise.resolve());
    onError = jest.fn();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    log.mockRestore();
  });

  const deps = () => ({ defaultOrgSlug: ORG, setUserRole, onError });

  describe('afterAddMember', () => {
    it.each(ADMIN_GRANTING)('grants the flag when joining as %s', async (role) => {
      await syncAdminFlagOnAddMember({ member: { role }, user: USER, organization: { slug: ORG } }, deps());
      expect(setUserRole).toHaveBeenCalledWith('u1', 'admin');
    });

    it.each(NON_ADMIN_GRANTING)('leaves the flag alone when joining as %s', async (role) => {
      await syncAdminFlagOnAddMember({ member: { role }, user: USER, organization: { slug: ORG } }, deps());
      expect(setUserRole).not.toHaveBeenCalled();
    });

    it('ignores organizations other than the default', async () => {
      await syncAdminFlagOnAddMember(
        { member: { role: 'stationManager' }, user: USER, organization: { slug: 'some-other-org' } },
        deps()
      );
      expect(setUserRole).not.toHaveBeenCalled();
    });

    it('warns and does nothing when DEFAULT_ORG_SLUG is unset', async () => {
      await syncAdminFlagOnAddMember(
        { member: { role: 'stationManager' }, user: USER, organization: { slug: ORG } },
        { ...deps(), defaultOrgSlug: undefined }
      );
      expect(setUserRole).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('DEFAULT_ORG_SLUG is not set, skipping admin role sync');
    });

    it('routes a write failure to onError rather than throwing', async () => {
      const boom = new Error('write failed');
      setUserRole.mockImplementation(() => Promise.reject(boom));
      await expect(
        syncAdminFlagOnAddMember(
          { member: { role: 'stationManager' }, user: USER, organization: { slug: ORG } },
          deps()
        )
      ).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledWith(boom);
    });
  });

  describe('afterUpdateMemberRole', () => {
    it('grants the flag on promotion across the boundary', async () => {
      await syncAdminFlagOnUpdateMemberRole(
        { member: { role: 'stationManager' }, previousRole: 'dj', user: USER, organization: { slug: ORG } },
        deps()
      );
      expect(setUserRole).toHaveBeenCalledWith('u1', 'admin');
    });

    it('revokes the flag on demotion across the boundary', async () => {
      await syncAdminFlagOnUpdateMemberRole(
        { member: { role: 'dj' }, previousRole: 'stationManager', user: USER, organization: { slug: ORG } },
        deps()
      );
      expect(setUserRole).toHaveBeenCalledWith('u1', null);
    });

    it.each([
      ['admin', 'owner'],
      ['owner', 'stationManager'],
    ])('does nothing moving %s -> %s, both of which grant the flag', async (previousRole, role) => {
      await syncAdminFlagOnUpdateMemberRole(
        { member: { role }, previousRole, user: USER, organization: { slug: ORG } },
        deps()
      );
      expect(setUserRole).not.toHaveBeenCalled();
    });

    it('does nothing moving dj -> musicDirector, neither of which grants the flag', async () => {
      await syncAdminFlagOnUpdateMemberRole(
        { member: { role: 'musicDirector' }, previousRole: 'dj', user: USER, organization: { slug: ORG } },
        deps()
      );
      expect(setUserRole).not.toHaveBeenCalled();
    });

    it('ignores organizations other than the default', async () => {
      await syncAdminFlagOnUpdateMemberRole(
        {
          member: { role: 'stationManager' },
          previousRole: 'dj',
          user: USER,
          organization: { slug: 'some-other-org' },
        },
        deps()
      );
      expect(setUserRole).not.toHaveBeenCalled();
    });
  });

  describe('afterRemoveMember', () => {
    const removeDeps = (hasOther: boolean) => ({
      ...deps(),
      hasOtherAdminMembership: jest.fn(() => Promise.resolve(hasOther)),
    });

    it('revokes the flag when no other membership justifies it', async () => {
      await syncAdminFlagOnRemoveMember({ user: USER, organization: { slug: ORG } }, removeDeps(false));
      expect(setUserRole).toHaveBeenCalledWith('u1', null);
    });

    it('keeps the flag when another membership still justifies it', async () => {
      await syncAdminFlagOnRemoveMember({ user: USER, organization: { slug: ORG } }, removeDeps(true));
      expect(setUserRole).not.toHaveBeenCalled();
    });

    it('scopes the second-membership check to the default organization', async () => {
      const d = removeDeps(false);
      await syncAdminFlagOnRemoveMember({ user: USER, organization: { slug: ORG } }, d);
      expect(d.hasOtherAdminMembership).toHaveBeenCalledWith('u1', ORG);
    });

    it('ignores organizations other than the default', async () => {
      const d = removeDeps(false);
      await syncAdminFlagOnRemoveMember({ user: USER, organization: { slug: 'some-other-org' } }, d);
      expect(d.hasOtherAdminMembership).not.toHaveBeenCalled();
      expect(setUserRole).not.toHaveBeenCalled();
    });

    it('routes a failed membership check to onError rather than throwing', async () => {
      const boom = new Error('query failed');
      await expect(
        syncAdminFlagOnRemoveMember(
          { user: USER, organization: { slug: ORG } },
          { ...deps(), hasOtherAdminMembership: jest.fn(() => Promise.reject(boom)) }
        )
      ).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledWith(boom);
      expect(setUserRole).not.toHaveBeenCalled();
    });
  });
});

/**
 * `grantsAdminFlag` is now the ONE definition of "this membership role carries
 * the global admin flag" — consumed by the grant path (the hooks above), the
 * revocation path (`hasOtherAdminMembership` in auth.definition.ts), the
 * provisioning path, and the backfill script, each of which previously held a
 * verbatim `['stationManager', 'admin', 'owner']` copy (BS#2282).
 *
 * The hazard this closes: `normalizeRole` widened when it took over shared's
 * alias table, so the grant path began accepting `station_manager` while a
 * hardcoded SQL IN-list on the revocation side did not. A user granted the
 * flag by a string the revocation path can't see would keep it forever.
 */
describe('grantsAdminFlag as the single admin-flag predicate', () => {
  it.each(['stationManager', 'admin', 'owner'])('%s grants the flag', (role) => {
    expect(grantsAdminFlag(role)).toBe(true);
  });

  it.each(['member', 'dj', 'musicDirector'])('%s does not grant the flag', (role) => {
    expect(grantsAdminFlag(role)).toBe(false);
  });

  it.each(['station_manager', 'STATIONMANAGER', ' admin '])(
    'accepts the alias variant %j (widened with the shared alias table)',
    (role) => {
      expect(grantsAdminFlag(role)).toBe(true);
    }
  );

  it.each(['user', 'station-manager', 'unknown', 'toString', 'constructor', '__proto__'])(
    'fails closed on %j',
    (role) => {
      expect(grantsAdminFlag(role)).toBe(false);
    }
  );

  /**
   * The revocation path's shape, replicated: it selects every membership row
   * for the user in the default org and filters in TS. There is deliberately
   * no `.limit(1)` there — with the role predicate out of SQL, a limit would
   * return one arbitrary row, and this multi-membership case is exactly what
   * would break.
   */
  const revocationFilter = (rows: { role: string }[]) => rows.some((r) => grantsAdminFlag(r.role));

  it('sees a stationManager membership held alongside a dj membership', () => {
    expect(revocationFilter([{ role: 'dj' }, { role: 'stationManager' }])).toBe(true);
  });

  it('agrees with the grant path on every string, including the widened aliases', () => {
    for (const role of [
      'stationManager',
      'admin',
      'owner',
      'station_manager',
      'STATIONMANAGER',
      'dj',
      'member',
      'musicDirector',
      'user',
      'toString',
    ]) {
      expect(revocationFilter([{ role }])).toBe(grantsAdminFlag(role));
    }
  });
});
