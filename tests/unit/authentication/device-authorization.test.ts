import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// better-auth/api's APIError is the only thing the module under test
// imports from better-auth. Stubbed because the real subpath ships ESM
// Jest can't load without ts-jest ESM mode (see auth-bypass.test pattern).
jest.mock('better-auth/api', () => ({
  APIError: class APIError extends Error {
    body: { error: string; error_description: string };
    constructor(_status: string, body: { error: string; error_description: string }) {
      super(body.error);
      this.body = body;
    }
  },
}));

jest.mock('better-auth/plugins/access', () => ({
  createAccessControl: () => ({
    newRole: (statements: any) => ({ authorize: () => ({ success: true }), statements }),
  }),
}));
jest.mock('better-auth/plugins/organization/access', () => ({
  adminAc: { statements: {} },
  defaultStatements: {},
}));

import {
  DEVICE_SESSION_TTL_MS,
  applyDeviceApproveRoleGate,
  applyDeviceTokenSessionTtl,
} from '../../../shared/authentication/src/device-authorization';

describe('applyDeviceApproveRoleGate', () => {
  it.each(['dj', 'musicDirector', 'stationManager'])('lets %s through without throwing', async (role) => {
    const select = jest.fn(() => Promise.resolve({ role }));
    await expect(applyDeviceApproveRoleGate('user-1', select)).resolves.toBeUndefined();
    expect(select).toHaveBeenCalledWith('user-1');
  });

  it('rejects a member with access_denied', async () => {
    const select = jest.fn(() => Promise.resolve({ role: 'member' }));
    await expect(applyDeviceApproveRoleGate('user-1', select)).rejects.toMatchObject({
      body: { error: 'access_denied' },
    });
  });

  it('rejects users with no membership row (defensive)', async () => {
    const select = jest.fn(() => Promise.resolve(undefined));
    await expect(applyDeviceApproveRoleGate('user-1', select)).rejects.toMatchObject({
      body: { error: 'access_denied' },
    });
  });

  it('rejects users whose role is not in WXYCRoles', async () => {
    const select = jest.fn(() => Promise.resolve({ role: 'admin' }));
    await expect(applyDeviceApproveRoleGate('user-1', select)).rejects.toMatchObject({
      body: { error: 'access_denied' },
    });
  });
});

describe('applyDeviceTokenSessionTtl', () => {
  let updateSessionExpiry: jest.Mock<(token: string, expiresAt: Date) => Promise<void>>;

  beforeEach(() => {
    updateSessionExpiry = jest.fn(() => Promise.resolve());
  });

  it('exposes a 12-hour constant', () => {
    expect(DEVICE_SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });

  it('mutates the response body expires_in to 43200 (12h in seconds)', async () => {
    const body: { expires_in?: number } = { expires_in: 7 * 24 * 60 * 60 };
    await applyDeviceTokenSessionTtl('tok', body, new Date('2026-06-24T00:00:00Z'), updateSessionExpiry);
    expect(body.expires_in).toBe(12 * 60 * 60);
  });

  it('targets the session whose token matches access_token', async () => {
    const body: { expires_in?: number } = {};
    await applyDeviceTokenSessionTtl('access-tok-xyz', body, new Date('2026-06-24T00:00:00Z'), updateSessionExpiry);
    expect(updateSessionExpiry).toHaveBeenCalledTimes(1);
    expect(updateSessionExpiry.mock.calls[0][0]).toBe('access-tok-xyz');
  });

  it('sets expiresAt to now + 12h', async () => {
    const now = new Date('2026-06-24T00:00:00Z');
    const body: { expires_in?: number } = {};
    await applyDeviceTokenSessionTtl('tok', body, now, updateSessionExpiry);
    const passedExpiresAt = updateSessionExpiry.mock.calls[0][1];
    expect(passedExpiresAt.getTime() - now.getTime()).toBe(DEVICE_SESSION_TTL_MS);
  });
});
