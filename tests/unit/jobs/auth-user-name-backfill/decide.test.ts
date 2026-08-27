/**
 * Unit tests for the auth_user.name backfill's pure decision functions
 * (DJ real-name PII safeguards plan, Track 2d).
 *
 * @wxyc/database resolves to tests/mocks/database.mock.ts (jest.unit.config.ts
 * moduleNameMapper), which re-exports the REAL resolveDjDisplayName from
 * shared/database/src/dj-name.ts — decideAuthUserNameBackfill is exercised
 * against the actual PII-safe chain, not a stub of it.
 */

import { describe, it, expect } from '@jest/globals';
import {
  decideAuthUserNameBackfill,
  violatesPreserveFirstPrecondition,
} from '../../../../jobs/auth-user-name-backfill/decide';

describe('violatesPreserveFirstPrecondition (2a preserve-first gate predicate)', () => {
  it('flags a row whose only legal-name copy is in name (real_name blank, name is neither Anonymous/Auto DJ/username)', () => {
    expect(
      violatesPreserveFirstPrecondition({ realName: null, isAnonymous: false, name: 'Jane Doe', username: 'jane_dj' })
    ).toBe(true);
  });

  it('flags a row whose real_name is whitespace-only', () => {
    expect(
      violatesPreserveFirstPrecondition({ realName: '   ', isAnonymous: false, name: 'Jane Doe', username: 'jane_dj' })
    ).toBe(true);
  });

  it('does not flag a row that already has a real_name', () => {
    expect(
      violatesPreserveFirstPrecondition({
        realName: 'Jane Doe',
        isAnonymous: false,
        name: 'Jane Doe',
        username: 'jane_dj',
      })
    ).toBe(false);
  });

  it('does not flag an anonymous user', () => {
    expect(
      violatesPreserveFirstPrecondition({ realName: null, isAnonymous: true, name: 'Anonymous', username: null })
    ).toBe(false);
  });

  it('does not flag the literal Anonymous name', () => {
    expect(
      violatesPreserveFirstPrecondition({ realName: null, isAnonymous: false, name: 'Anonymous', username: null })
    ).toBe(false);
  });

  it('does not flag the literal Auto DJ service-account name', () => {
    expect(
      violatesPreserveFirstPrecondition({ realName: null, isAnonymous: false, name: 'Auto DJ', username: 'autodj' })
    ).toBe(false);
  });

  it('does not flag a row where name already equals username (handle-less user with no real name to lose)', () => {
    expect(
      violatesPreserveFirstPrecondition({ realName: null, isAnonymous: false, name: 'jane_dj', username: 'jane_dj' })
    ).toBe(false);
  });

  it('null-safely treats name/username as distinct when username is null (IS DISTINCT FROM semantics)', () => {
    expect(
      violatesPreserveFirstPrecondition({ realName: null, isAnonymous: false, name: 'Jane Doe', username: null })
    ).toBe(true);
  });
});

describe('decideAuthUserNameBackfill', () => {
  it('derives the handle when djName is a usable handle', () => {
    expect(
      decideAuthUserNameBackfill({ name: 'Jane Doe', username: 'jane_dj', djName: 'DJ Jazzy Jane', isAnonymous: false })
    ).toBe('DJ Jazzy Jane');
  });

  it('falls back to username when djName is absent', () => {
    expect(
      decideAuthUserNameBackfill({ name: 'Jane Doe', username: 'jane_dj', djName: null, isAnonymous: false })
    ).toBe('jane_dj');
  });

  it('falls back to username when djName is the literal Anonymous', () => {
    expect(
      decideAuthUserNameBackfill({ name: 'Jane Doe', username: 'jane_dj', djName: 'Anonymous', isAnonymous: false })
    ).toBe('jane_dj');
  });

  it('leaves the row unchanged when the user is anonymous', () => {
    expect(
      decideAuthUserNameBackfill({ name: 'Anonymous', username: null, djName: null, isAnonymous: true })
    ).toBeUndefined();
  });

  it('leaves the row unchanged when name is the literal Auto DJ', () => {
    expect(
      decideAuthUserNameBackfill({ name: 'Auto DJ', username: 'autodj', djName: 'Auto DJ', isAnonymous: false })
    ).toBeUndefined();
  });

  it('leaves the row unchanged when neither a usable handle nor a username exists', () => {
    expect(
      decideAuthUserNameBackfill({ name: 'Jane Doe', username: null, djName: null, isAnonymous: false })
    ).toBeUndefined();
  });

  it('is a no-op when the derived value already equals the stored name', () => {
    expect(
      decideAuthUserNameBackfill({ name: 'jane_dj', username: 'jane_dj', djName: null, isAnonymous: false })
    ).toBeUndefined();
  });
});
