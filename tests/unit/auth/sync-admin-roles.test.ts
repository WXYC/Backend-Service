/**
 * Characterization tests for the startup reconciler extracted out of
 * `apps/auth/app.ts`, where it sat behind the `app.listen()` IIFE and could
 * not be imported at all.
 *
 * The reconciler is the retry path for a membership hook that failed, so its
 * load-bearing property is that it converges without operator intervention.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import { syncAdminRoles, type AdminFlagMismatch } from '../../../apps/auth/sync-admin-roles';

const mismatch = (over: Partial<AdminFlagMismatch> = {}): AdminFlagMismatch => ({
  userId: 'u1',
  userEmail: 'sm@wxyc.org',
  userRole: null,
  memberRole: 'stationManager',
  ...over,
});

describe('syncAdminRoles', () => {
  let setUserRole: jest.Mock<(userId: string, role: 'admin' | null) => Promise<void>>;
  let log: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    setUserRole = jest.fn(() => Promise.resolve());
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
  });

  const findReturning = (rows: AdminFlagMismatch[]) => jest.fn(() => Promise.resolve(rows));

  it('grants the flag to every user missing it', async () => {
    const find = findReturning([mismatch(), mismatch({ userId: 'u2', userEmail: 'sm2@wxyc.org' })]);

    await syncAdminRoles({ defaultOrgSlug: 'wxyc', findUsersMissingAdminFlag: find, setUserRole });

    expect(setUserRole).toHaveBeenCalledTimes(2);
    expect(setUserRole).toHaveBeenCalledWith('u1', 'admin');
    expect(setUserRole).toHaveBeenCalledWith('u2', 'admin');
  });

  it('scopes the search to the configured organization', async () => {
    const find = findReturning([]);
    await syncAdminRoles({ defaultOrgSlug: 'wxyc', findUsersMissingAdminFlag: find, setUserRole });
    expect(find).toHaveBeenCalledWith('wxyc');
  });

  it('writes nothing when every membership already agrees', async () => {
    await syncAdminRoles({ defaultOrgSlug: 'wxyc', findUsersMissingAdminFlag: findReturning([]), setUserRole });
    expect(setUserRole).not.toHaveBeenCalled();
  });

  it('skips entirely — without querying — when DEFAULT_ORG_SLUG is unset', async () => {
    const find = findReturning([mismatch()]);

    await syncAdminRoles({ defaultOrgSlug: undefined, findUsersMissingAdminFlag: find, setUserRole });

    expect(find).not.toHaveBeenCalled();
    expect(setUserRole).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[ADMIN PERMISSIONS] DEFAULT_ORG_SLUG not set, skipping admin role fix');
  });

  it('propagates a failed lookup to the caller, which owns the warn-and-continue', async () => {
    const boom = new Error('connection terminated');
    await expect(
      syncAdminRoles({
        defaultOrgSlug: 'wxyc',
        findUsersMissingAdminFlag: jest.fn(() => Promise.reject(boom)),
        setUserRole,
      })
    ).rejects.toBe(boom);
  });

  it('propagates a mid-loop write failure, leaving the remainder for the next boot', async () => {
    const boom = new Error('write failed');
    setUserRole.mockImplementationOnce(() => Promise.resolve()).mockImplementationOnce(() => Promise.reject(boom));
    const find = findReturning([mismatch(), mismatch({ userId: 'u2' }), mismatch({ userId: 'u3' })]);

    await expect(syncAdminRoles({ defaultOrgSlug: 'wxyc', findUsersMissingAdminFlag: find, setUserRole })).rejects.toBe(
      boom
    );

    // Stopped at the failure — u3 is untouched and is re-found on the next boot.
    expect(setUserRole).toHaveBeenCalledTimes(2);
    expect(setUserRole).not.toHaveBeenCalledWith('u3', 'admin');
  });
});
