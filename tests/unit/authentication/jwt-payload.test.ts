/**
 * Characterization tests for the role resolution extracted out of the
 * `betterAuth({...})` literal. These pin the behavior as it was BEFORE the
 * extraction, so the move itself is provably behavior-preserving — the
 * existing suite cannot do that, because every other unit test against
 * `auth.definition.ts` is a source-scan and never executes this code.
 *
 * BS#2171 changes some of this deliberately (the fallback stops carrying a
 * station role). When that lands, the assertions it invalidates should be
 * changed with intent, not deleted as noise.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import { buildJwtPayload, buildOidcUserInfoClaim } from '../../../shared/authentication/src/jwt-payload';

type FetchMock = jest.Mock<(userId: string) => Promise<{ role: string } | undefined>>;

describe('buildJwtPayload', () => {
  let onError: jest.Mock<(error: unknown) => void>;

  beforeEach(() => {
    onError = jest.fn();
  });

  const fetchReturning = (row: { role: string } | undefined): FetchMock => jest.fn(() => Promise.resolve(row));

  it('resolves role from the membership row, not from the user', async () => {
    const fetch = fetchReturning({ role: 'musicDirector' });
    // `role: 'admin'` on the user is the better-auth admin flag. It must not
    // become the station role in the token — that confusion is BS#2171.
    const payload = await buildJwtPayload({ id: 'u1', role: 'admin' }, fetch, onError);

    expect(payload.role).toBe('musicDirector');
    expect(fetch).toHaveBeenCalledWith('u1');
    expect(onError).not.toHaveBeenCalled();
  });

  it('defaults capabilities to [] when the user carries none', async () => {
    const payload = await buildJwtPayload({ id: 'u1' }, fetchReturning({ role: 'dj' }), onError);
    expect(payload.capabilities).toEqual([]);
  });

  it('passes through capabilities the user carries', async () => {
    const payload = await buildJwtPayload(
      { id: 'u1', capabilities: ['catalog:write'] },
      fetchReturning({ role: 'dj' }),
      onError
    );
    expect(payload.capabilities).toEqual(['catalog:write']);
  });

  it('spreads the rest of the user through untouched', async () => {
    const payload = await buildJwtPayload(
      { id: 'u1', email: 'dj@wxyc.org', banned: true, banReason: 'spam' },
      fetchReturning({ role: 'dj' }),
      onError
    );
    // auth.middleware.ts gates suspended accounts on these two fields, and
    // they reach it only via this spread.
    expect(payload).toMatchObject({ email: 'dj@wxyc.org', banned: true, banReason: 'spam' });
  });

  describe('when no role can be resolved', () => {
    it('omits role entirely for a user with no membership row', async () => {
      const payload = await buildJwtPayload({ id: 'u1' }, fetchReturning(undefined), onError);
      expect(payload).not.toHaveProperty('role');
      expect(onError).not.toHaveBeenCalled();
    });

    it('reports a failed lookup through onError and still returns a payload', async () => {
      const boom = new Error('connection terminated');
      const fetch: FetchMock = jest.fn(() => Promise.reject(boom));

      const payload = await buildJwtPayload({ id: 'u1', email: 'dj@wxyc.org' }, fetch, onError);

      expect(onError).toHaveBeenCalledWith(boom);
      expect(payload).toMatchObject({ id: 'u1', email: 'dj@wxyc.org', capabilities: [] });
    });

    it('skips the lookup for a user with no id', async () => {
      const fetch = fetchReturning({ role: 'dj' });
      const payload = await buildJwtPayload({}, fetch, onError);

      expect(fetch).not.toHaveBeenCalled();
      expect(payload).not.toHaveProperty('role');
    });

    it('carries the user through even when the lookup fails — pinning the pre-BS#2171 fallback', async () => {
      // The fallback currently spreads `...user`, so a stale admin flag on the
      // user row survives into the token. BS#2171 removes exactly this.
      const fetch: FetchMock = jest.fn(() => Promise.reject(new Error('down')));
      const payload = await buildJwtPayload({ id: 'u1', role: 'admin' }, fetch, onError);
      expect(payload.role).toBe('admin');
    });
  });
});

describe('buildOidcUserInfoClaim', () => {
  it('resolves role from the membership row', async () => {
    const claim = await buildOidcUserInfoClaim(
      { id: 'u1' },
      jest.fn(() => Promise.resolve({ role: 'stationManager' }))
    );
    expect(claim).toEqual({ role: 'stationManager', capabilities: [] });
  });

  it('passes through capabilities the user record carries', async () => {
    const claim = await buildOidcUserInfoClaim(
      { id: 'u1', capabilities: ['flowsheet:write'] },
      jest.fn(() => Promise.resolve({ role: 'dj' }))
    );
    expect(claim.capabilities).toEqual(['flowsheet:write']);
  });

  it('degrades to the least-privileged role when there is no membership row', async () => {
    const claim = await buildOidcUserInfoClaim(
      { id: 'u1' },
      jest.fn(() => Promise.resolve(undefined))
    );
    expect(claim.role).toBe('member');
  });

  it('degrades to member and drops capabilities when the lookup throws', async () => {
    // Fail-closed: an id_token must never claim more authority than the
    // caller can prove, and this path has no onError by design — see the
    // module docstring.
    const claim = await buildOidcUserInfoClaim(
      { id: 'u1', capabilities: ['catalog:write'] },
      jest.fn(() => Promise.reject(new Error('down')))
    );
    expect(claim).toEqual({ role: 'member', capabilities: [] });
  });
});
