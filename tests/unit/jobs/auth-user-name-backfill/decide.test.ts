/**
 * Unit tests for the auth_user.name backfill's pure decision functions
 * (DJ real-name PII safeguards plan, Track 2d).
 *
 * @wxyc/database resolves to tests/mocks/database.mock.ts (jest.unit.config.ts
 * moduleNameMapper), which re-exports the REAL resolveDjDisplayName /
 * deriveUserPublicName from shared/database/src/dj-name.ts — both decision
 * functions here are exercised against the actual PII-safe chain, not a
 * stub of it.
 */

import { describe, it, expect } from '@jest/globals';
import {
  decideAuthUserNameBackfill,
  violatesPreserveFirstPrecondition,
} from '../../../../jobs/auth-user-name-backfill/decide';

// Mirrors job.test.ts's rawRow(overrides) pattern: a default row shaped like
// the common case for both describe blocks below (case 1 of the gate suite,
// case 2 of the decide suite), so each test shows only the fields its case
// actually varies. `realName` is unused by decideAuthUserNameBackfill but
// harmless to carry — same "one factory, ignore what a caller doesn't need"
// convention as job.test.ts's rawRow.
const row = (
  overrides: Partial<Record<'realName' | 'isAnonymous' | 'name' | 'username' | 'djName', unknown>> = {}
) => ({
  realName: null,
  isAnonymous: false,
  name: 'Jane Doe',
  username: 'jane_dj',
  djName: null,
  ...overrides,
});

describe('violatesPreserveFirstPrecondition (2a preserve-first gate predicate)', () => {
  it('flags a row whose only legal-name copy is in name (real_name blank, name is neither Anonymous/Auto DJ/username)', () => {
    expect(violatesPreserveFirstPrecondition(row())).toBe(true);
  });

  it('flags a row whose real_name is whitespace-only', () => {
    expect(violatesPreserveFirstPrecondition(row({ realName: '   ' }))).toBe(true);
  });

  it('does not flag a row that already has a real_name', () => {
    expect(violatesPreserveFirstPrecondition(row({ realName: 'Jane Doe' }))).toBe(false);
  });

  it('does not flag an anonymous user', () => {
    expect(violatesPreserveFirstPrecondition(row({ isAnonymous: true, name: 'Anonymous', username: null }))).toBe(
      false
    );
  });

  it('does not flag the literal Anonymous name', () => {
    expect(violatesPreserveFirstPrecondition(row({ name: 'Anonymous', username: null }))).toBe(false);
  });

  it('does not flag the literal Auto DJ service-account name', () => {
    expect(violatesPreserveFirstPrecondition(row({ name: 'Auto DJ', username: 'autodj', djName: 'Auto DJ' }))).toBe(
      false
    );
  });

  it('does not flag a row where name already equals username (handle-less user with no real name to lose)', () => {
    expect(violatesPreserveFirstPrecondition(row({ name: 'jane_dj' }))).toBe(false);
  });

  it('null-safely treats name/username as distinct when username is null (IS DISTINCT FROM semantics)', () => {
    expect(violatesPreserveFirstPrecondition(row({ username: null }))).toBe(true);
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
      violatesPreserveFirstPrecondition(row({ name: 'DJ Jazzy Jane', username: 'jjane', djName: 'DJ Jazzy Jane' }))
    ).toBe(false);
  });

  it('still flags a genuine legacy row: name is a legal-looking value distinct from both the handle and username', () => {
    expect(violatesPreserveFirstPrecondition(row({ username: 'jjane', djName: 'DJ Jazzy Jane' }))).toBe(true);
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
    expect(violatesPreserveFirstPrecondition(row({ username: 'jjane', djName: 'Jane Doe' }))).toBe(false);
  });
});

describe('decideAuthUserNameBackfill', () => {
  it('derives the handle when djName is a usable handle', () => {
    expect(decideAuthUserNameBackfill(row({ djName: 'DJ Jazzy Jane' }))).toBe('DJ Jazzy Jane');
  });

  it('falls back to username when djName is absent', () => {
    expect(decideAuthUserNameBackfill(row())).toBe('jane_dj');
  });

  it('falls back to username when djName is the literal Anonymous', () => {
    expect(decideAuthUserNameBackfill(row({ djName: 'Anonymous' }))).toBe('jane_dj');
  });

  it('leaves the row unchanged when the user is anonymous', () => {
    expect(decideAuthUserNameBackfill(row({ isAnonymous: true, name: 'Anonymous', username: null }))).toBeUndefined();
  });

  it('leaves the row unchanged when name is the literal Auto DJ', () => {
    expect(decideAuthUserNameBackfill(row({ name: 'Auto DJ', username: 'autodj', djName: 'Auto DJ' }))).toBeUndefined();
  });

  it('leaves the row unchanged when neither a usable handle nor a username exists', () => {
    expect(decideAuthUserNameBackfill(row({ username: null }))).toBeUndefined();
  });

  it('is a no-op when the derived value already equals the stored name', () => {
    expect(decideAuthUserNameBackfill(row({ name: 'jane_dj' }))).toBeUndefined();
  });
});
