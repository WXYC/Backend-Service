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
      violatesPreserveFirstPrecondition({
        realName: null,
        isAnonymous: false,
        name: 'Jane Doe',
        username: 'jane_dj',
        djName: null,
      })
    ).toBe(true);
  });

  it('flags a row whose real_name is whitespace-only', () => {
    expect(
      violatesPreserveFirstPrecondition({
        realName: '   ',
        isAnonymous: false,
        name: 'Jane Doe',
        username: 'jane_dj',
        djName: null,
      })
    ).toBe(true);
  });

  it('does not flag a row that already has a real_name', () => {
    expect(
      violatesPreserveFirstPrecondition({
        realName: 'Jane Doe',
        isAnonymous: false,
        name: 'Jane Doe',
        username: 'jane_dj',
        djName: null,
      })
    ).toBe(false);
  });

  it('does not flag an anonymous user', () => {
    expect(
      violatesPreserveFirstPrecondition({
        realName: null,
        isAnonymous: true,
        name: 'Anonymous',
        username: null,
        djName: null,
      })
    ).toBe(false);
  });

  it('does not flag the literal Anonymous name', () => {
    expect(
      violatesPreserveFirstPrecondition({
        realName: null,
        isAnonymous: false,
        name: 'Anonymous',
        username: null,
        djName: null,
      })
    ).toBe(false);
  });

  it('does not flag the literal Auto DJ service-account name', () => {
    expect(
      violatesPreserveFirstPrecondition({
        realName: null,
        isAnonymous: false,
        name: 'Auto DJ',
        username: 'autodj',
        djName: 'Auto DJ',
      })
    ).toBe(false);
  });

  it('does not flag a row where name already equals username (handle-less user with no real name to lose)', () => {
    expect(
      violatesPreserveFirstPrecondition({
        realName: null,
        isAnonymous: false,
        name: 'jane_dj',
        username: 'jane_dj',
        djName: null,
      })
    ).toBe(false);
  });

  it('null-safely treats name/username as distinct when username is null (IS DISTINCT FROM semantics)', () => {
    expect(
      violatesPreserveFirstPrecondition({
        realName: null,
        isAnonymous: false,
        name: 'Jane Doe',
        username: null,
        djName: null,
      })
    ).toBe(true);
  });

  // FINDING 2 (2297 review): a user provisioned AFTER this PR deploys can
  // legitimately have name=handle, real_name blank, and name distinct from
  // username (e.g. no username chosen yet, or username differs from the
  // on-air handle) — that shape used to false-positive the gate forever,
  // and the gate's own remediation message ("run 2a first") would have had
  // an operator copy a HANDLE into the real_name PII column. Exempt any row
  // whose trimmed `name` equals the resolved handle: there is no legal name
  // to preserve, because `name` never held anything but the handle.
  it('does not flag a post-deploy-provisioned row: name is the on-air handle, real_name blank, name distinct from username', () => {
    expect(
      violatesPreserveFirstPrecondition({
        realName: null,
        isAnonymous: false,
        name: 'DJ Jazzy Jane',
        username: 'jjane',
        djName: 'DJ Jazzy Jane',
      })
    ).toBe(false);
  });

  it('still flags a genuine legacy row: name is a legal-looking value distinct from both the handle and username', () => {
    expect(
      violatesPreserveFirstPrecondition({
        realName: null,
        isAnonymous: false,
        name: 'Jane Doe',
        username: 'jjane',
        djName: 'DJ Jazzy Jane',
      })
    ).toBe(true);
  });

  // Handle-is-real-name edge: a DJ whose real legal name coincidentally
  // matches their on-air handle (e.g. handle "Jane Doe"). This row is
  // exempted by the same rule as the post-deploy case above — trim(name)
  // equals the resolved handle — even though `name` here also happens to
  // equal what would be the real name. That's fine: 2a's own audit SQL
  // carries the identical exemption ("handle-is-real-name", same as the
  // stored-data scrub's), and there is genuinely no information lost by
  // skipping this row — real_name still gets backfilled from `name` at 2a
  // if it's ever populated by some other means, and the backfill job (2d)
  // never overwrites a row's `name` away from a value that already equals
  // its resolved handle (decideAuthUserNameBackfill is a no-op there too).
  it('does not flag the handle-is-real-name coincidence: name equals both the handle and what could be a legal name', () => {
    expect(
      violatesPreserveFirstPrecondition({
        realName: null,
        isAnonymous: false,
        name: 'Jane Doe',
        username: 'jjane',
        djName: 'Jane Doe',
      })
    ).toBe(false);
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
