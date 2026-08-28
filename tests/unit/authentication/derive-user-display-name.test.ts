import { describe, it, expect } from '@jest/globals';

// @wxyc/database resolves to tests/mocks/database.mock.ts (jest.unit.config.ts
// moduleNameMapper), which re-exports the REAL resolveDjDisplayName from
// shared/database/src/dj-name.ts — these tests exercise the actual chain, not
// a stub of it.

import {
  deriveUserNameOnCreate,
  deriveOrRejectUserNameOnUpdate,
} from '../../../shared/authentication/src/derive-user-display-name';

describe('deriveUserNameOnCreate', () => {
  it('derives the on-air handle when djName is usable', () => {
    const result = deriveUserNameOnCreate({
      name: 'realname-in-name-field',
      username: 'jane_dj',
      djName: 'DJ Jazzy Jane',
    });
    expect(result).toEqual({ data: { name: 'DJ Jazzy Jane' } });
  });

  it('falls back to username when djName is absent', () => {
    const result = deriveUserNameOnCreate({ name: 'realname-in-name-field', username: 'jane_dj' });
    expect(result).toEqual({ data: { name: 'jane_dj' } });
  });

  it('falls back to username when djName is the literal Anonymous', () => {
    const result = deriveUserNameOnCreate({ name: 'realname-in-name-field', username: 'jane_dj', djName: 'Anonymous' });
    expect(result).toEqual({ data: { name: 'jane_dj' } });
  });

  it('preserves the literal Anonymous name for the anonymous plugin (no username, no djName)', () => {
    const result = deriveUserNameOnCreate({ name: 'Anonymous' });
    expect(result).toBeUndefined();
  });

  it('preserves the literal Auto DJ name for the auto-DJ service account', () => {
    // create-auto-dj-user.ts supplies djName: 'Auto DJ' too — resolveDjDisplayName
    // treats 'Auto DJ' as a usable (non-'Anonymous') handle, so derived equals
    // the supplied name either way and the no-op branch fires.
    const result = deriveUserNameOnCreate({ name: 'Auto DJ', username: 'autodj', djName: 'Auto DJ' });
    expect(result).toBeUndefined();
  });

  it('is a no-op when the derived value already equals the supplied name', () => {
    const result = deriveUserNameOnCreate({ name: 'jane_dj', username: 'jane_dj' });
    expect(result).toBeUndefined();
  });

  it('trims and treats a blank djName as unusable, falling through to username', () => {
    const result = deriveUserNameOnCreate({ name: 'realname-in-name-field', username: 'jane_dj', djName: '   ' });
    expect(result).toEqual({ data: { name: 'jane_dj' } });
  });
});

describe('deriveOrRejectUserNameOnUpdate', () => {
  it('derives the handle when the update sets a usable djName', () => {
    const result = deriveOrRejectUserNameOnUpdate({ djName: 'DJ Jazzy Jane' });
    expect(result).toEqual({ data: { name: 'DJ Jazzy Jane' } });
  });

  it('leaves name untouched when the update clears the handle (blank djName)', () => {
    const result = deriveOrRejectUserNameOnUpdate({ djName: '' });
    expect(result).toBeUndefined();
  });

  it('leaves name untouched on a username-only payload (no djName key at all)', () => {
    const result = deriveOrRejectUserNameOnUpdate({ username: 'new_username' });
    expect(result).toBeUndefined();
  });

  it('leaves name untouched when djName is set to the literal Anonymous', () => {
    const result = deriveOrRejectUserNameOnUpdate({ djName: 'Anonymous' });
    expect(result).toBeUndefined();
  });

  it('derives from djName on an onboarding-shaped payload carrying both realName and djName', () => {
    // complete-onboarding.ts's markOnboardingComplete builds exactly this
    // shape: { realName, djName, ... } via internalAdapter.updateUser, which
    // still flows through updateWithHooks.
    const result = deriveOrRejectUserNameOnUpdate({ realName: 'Jane Doe', djName: 'DJ Jazzy Jane' });
    expect(result).toEqual({ data: { name: 'DJ Jazzy Jane' } });
  });

  it('leaves name untouched when djName is explicitly null', () => {
    const result = deriveOrRejectUserNameOnUpdate({ djName: null });
    expect(result).toBeUndefined();
  });

  // FINDING 1 (2297 review) rejection policy — full writeup lives once, on
  // deriveOrRejectUserNameOnUpdate's docblock in derive-user-display-name.ts.
  it('rejects a name-only payload outright (djName key absent)', () => {
    const result = deriveOrRejectUserNameOnUpdate({ name: 'Some Real Name' });
    expect(result).toBe(false);
  });

  it('derives the handle and overrides a client-supplied name when both are present', () => {
    // The override is better-auth's merge order, not this function — see the
    // "MERGE CONTRACT" section of the docblock referenced above.
    const result = deriveOrRejectUserNameOnUpdate({ name: 'Some Real Name', djName: 'DJ Jazzy Jane' });
    expect(result).toEqual({ data: { name: 'DJ Jazzy Jane' } });
  });

  // Closes the trivial bypass of the name-only rejection above: without
  // this, a caller could smuggle a bare `name` write through by attaching
  // an unusable `djName` (blank, or the literal 'Anonymous') to the same
  // payload — djName would be "present" but resolve to no handle, and the
  // client-supplied name would slip through unrejected. A name-carrying
  // payload is only ever allowed to leave `name` alone when it does NOT
  // also try to set an unusable djName in the same breath; here it does
  // both, so it's rejected exactly like the name-only case.
  it('rejects a name payload accompanied by an unusable (blank) djName', () => {
    const result = deriveOrRejectUserNameOnUpdate({ name: 'Some Real Name', djName: '' });
    expect(result).toBe(false);
  });

  it('rejects a name payload accompanied by djName set to the literal Anonymous', () => {
    const result = deriveOrRejectUserNameOnUpdate({ name: 'Some Real Name', djName: 'Anonymous' });
    expect(result).toBe(false);
  });

  // better-auth's public POST /update-user handler (api/routes/update-user.mjs)
  // always builds its adapter payload as `{ name, image, ...additionalFields }`
  // — so EVERY update through that endpoint reaches this hook with the `name`
  // key present, value `undefined` whenever the client didn't send one. The
  // veto must therefore key on the VALUE, never on key presence: an undefined
  // `name` is "not supplied", not an attempted write. Regression test for the
  // key-presence veto that aborted every profile update (dj-site's
  // `updateUser({ appSkin })` experience switch included).
  it('no-ops on the endpoint-injected undefined name (unrelated-field update)', () => {
    const result = deriveOrRejectUserNameOnUpdate({
      name: undefined,
      image: undefined,
      appSkin: 'classic',
    });
    expect(result).toBeUndefined();
  });

  it('derives the handle when the endpoint-injected undefined name rides along with a usable djName', () => {
    const result = deriveOrRejectUserNameOnUpdate({ name: undefined, djName: 'DJ Jazzy Jane' });
    expect(result).toEqual({ data: { name: 'DJ Jazzy Jane' } });
  });

  it('still rejects an explicit null name (a supplied value, not an absent one)', () => {
    const result = deriveOrRejectUserNameOnUpdate({ name: null });
    expect(result).toBe(false);
  });
});
