import { describe, it, expect } from '@jest/globals';

// @wxyc/database resolves to tests/mocks/database.mock.ts (jest.unit.config.ts
// moduleNameMapper), which re-exports the REAL resolveDjDisplayName from
// shared/database/src/dj-name.ts — these tests exercise the actual chain, not
// a stub of it.

import {
  deriveUserNameOnCreate,
  deriveUserNameOnUpdate,
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

describe('deriveUserNameOnUpdate', () => {
  it('derives the handle when the update sets a usable djName', () => {
    const result = deriveUserNameOnUpdate({ djName: 'DJ Jazzy Jane' });
    expect(result).toEqual({ data: { name: 'DJ Jazzy Jane' } });
  });

  it('leaves name untouched when the update clears the handle (blank djName)', () => {
    const result = deriveUserNameOnUpdate({ djName: '' });
    expect(result).toBeUndefined();
  });

  it('leaves name untouched on a username-only payload (no djName key at all)', () => {
    const result = deriveUserNameOnUpdate({ username: 'new_username' });
    expect(result).toBeUndefined();
  });

  it('leaves name untouched when djName is set to the literal Anonymous', () => {
    const result = deriveUserNameOnUpdate({ djName: 'Anonymous' });
    expect(result).toBeUndefined();
  });

  it('derives from djName on an onboarding-shaped payload carrying both realName and djName', () => {
    // complete-onboarding.ts's markOnboardingComplete builds exactly this
    // shape: { realName, djName, ... } via internalAdapter.updateUser, which
    // still flows through updateWithHooks.
    const result = deriveUserNameOnUpdate({ realName: 'Jane Doe', djName: 'DJ Jazzy Jane' });
    expect(result).toEqual({ data: { name: 'DJ Jazzy Jane' } });
  });

  it('leaves name untouched when djName is explicitly null', () => {
    const result = deriveUserNameOnUpdate({ djName: null });
    expect(result).toBeUndefined();
  });
});
