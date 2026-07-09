import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// better-auth/api is stubbed at the jest.unit.config.ts moduleNameMapper
// level (better-auth-api.mock.ts) — the real subpath ships ESM ts-jest
// can't transform. Same pattern as better-auth/node, /plugins/access,
// /plugins/organization/access.

import {
  DEVICE_SESSION_TTL_MS,
  applyDeviceApproveRoleGate,
  applyDeviceTokenSessionTtl,
  capSessionUpdateAgainstDeviceFlow,
} from '../../../shared/authentication/src/device-authorization';

describe('applyDeviceApproveRoleGate', () => {
  let clearClaimant: jest.Mock<(userId: string) => Promise<void>>;

  beforeEach(() => {
    clearClaimant = jest.fn(() => Promise.resolve());
  });

  it.each(['dj', 'musicDirector', 'stationManager'])('lets %s through without throwing', async (role) => {
    const select = jest.fn(() => Promise.resolve({ role }));
    await expect(applyDeviceApproveRoleGate('user-1', select, clearClaimant)).resolves.toBeUndefined();
    expect(select).toHaveBeenCalledWith('user-1');
    // A permitted role does not reset the claim.
    expect(clearClaimant).not.toHaveBeenCalled();
  });

  it('rejects a member with access_denied and clears the claim so a DJ can re-claim', async () => {
    const select = jest.fn(() => Promise.resolve({ role: 'member' }));
    await expect(applyDeviceApproveRoleGate('user-1', select, clearClaimant)).rejects.toMatchObject({
      body: { error: 'access_denied' },
    });
    expect(clearClaimant).toHaveBeenCalledWith('user-1');
  });

  it('rejects users with no membership row and clears the claim (defensive)', async () => {
    const select = jest.fn(() => Promise.resolve(undefined));
    await expect(applyDeviceApproveRoleGate('user-1', select, clearClaimant)).rejects.toMatchObject({
      body: { error: 'access_denied' },
    });
    expect(clearClaimant).toHaveBeenCalledWith('user-1');
  });

  it('rejects users whose role is not in WXYCRoles', async () => {
    const select = jest.fn(() => Promise.resolve({ role: 'admin' }));
    await expect(applyDeviceApproveRoleGate('user-1', select, clearClaimant)).rejects.toMatchObject({
      body: { error: 'access_denied' },
    });
    expect(clearClaimant).toHaveBeenCalledWith('user-1');
  });

  it('rejects a prototype-chain key (toString) even though `in WXYCRoles` would accept it', async () => {
    // N3 (#1494 review): guarding with `Object.hasOwn` instead of `in` so
    // Object.prototype properties can't slip through the allowlist.
    const select = jest.fn(() => Promise.resolve({ role: 'toString' }));
    await expect(applyDeviceApproveRoleGate('user-1', select, clearClaimant)).rejects.toMatchObject({
      body: { error: 'access_denied' },
    });
    expect(clearClaimant).toHaveBeenCalledWith('user-1');
  });
});

describe('applyDeviceTokenSessionTtl', () => {
  let updateSessionExpiry: jest.Mock<(token: string, expiresAt: Date, deviceFlowExpiresAt: Date) => Promise<void>>;

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

  it('writes both expiresAt and deviceFlowExpiresAt at now + 12h', async () => {
    const now = new Date('2026-06-24T00:00:00Z');
    const body: { expires_in?: number } = {};
    await applyDeviceTokenSessionTtl('tok', body, now, updateSessionExpiry);
    const [, passedExpiresAt, passedDeviceFlow] = updateSessionExpiry.mock.calls[0];
    expect(passedExpiresAt.getTime() - now.getTime()).toBe(DEVICE_SESSION_TTL_MS);
    // The cap the update-hook enforces MUST be the same instant as the
    // initial expiresAt, or the very first refresh would legitimately walk
    // the row past mint + 12h.
    expect(passedDeviceFlow.getTime()).toBe(passedExpiresAt.getTime());
  });
});

describe('capSessionUpdateAgainstDeviceFlow', () => {
  const now = new Date('2026-06-24T00:00:00Z');
  const cap = new Date('2026-06-24T12:00:00Z'); // 12h after `now`

  it('returns undefined when the row has no device-flow cap (non-device session)', () => {
    const data = { expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) };
    expect(capSessionUpdateAgainstDeviceFlow(data, null)).toBeUndefined();
    expect(capSessionUpdateAgainstDeviceFlow(data, undefined)).toBeUndefined();
  });

  it('returns undefined when the payload does not touch expiresAt', () => {
    expect(capSessionUpdateAgainstDeviceFlow({ updatedAt: now }, cap)).toBeUndefined();
    expect(capSessionUpdateAgainstDeviceFlow({}, cap)).toBeUndefined();
  });

  it('downgrades expiresAt to the cap when the payload wants a later expiry', () => {
    // The 7-day refresh scenario the reviewer flagged: incoming = now + 7d,
    // cap = mint + 12h, so we override to the cap.
    const incoming = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const out = capSessionUpdateAgainstDeviceFlow({ expiresAt: incoming }, cap);
    expect(out).toEqual({ data: { expiresAt: cap } });
  });

  it('accepts ISO-string expiresAt just as it accepts Date', () => {
    const iso = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const out = capSessionUpdateAgainstDeviceFlow({ expiresAt: iso }, cap);
    expect(out).toEqual({ data: { expiresAt: cap } });
  });

  it('leaves earlier or equal expiresAt untouched', () => {
    const earlier = new Date(cap.getTime() - 60 * 1000); // 1 min before cap
    expect(capSessionUpdateAgainstDeviceFlow({ expiresAt: earlier }, cap)).toBeUndefined();
    expect(capSessionUpdateAgainstDeviceFlow({ expiresAt: cap }, cap)).toBeUndefined();
  });

  it('is a no-op when expiresAt parses to NaN (defensive)', () => {
    expect(capSessionUpdateAgainstDeviceFlow({ expiresAt: 'not-a-date' }, cap)).toBeUndefined();
  });
});
