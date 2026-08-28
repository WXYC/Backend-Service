/**
 * Unit tests for `deriveUserPublicName` (shared/database/src/dj-name.ts).
 *
 * The `auth_user.name` policy — on-air handle, else username — consolidated
 * from three independent call sites (apps/auth/provision-user.ts, the
 * databaseHooks.user.create.before hook, the auth-user-name-backfill job's
 * rewrite-target computation). See the function's docblock for why the
 * update hook does NOT use this helper (its username link is
 * create/backfill-only).
 */

import { deriveUserPublicName } from '../../../shared/database/src/dj-name';

describe('deriveUserPublicName', () => {
  it('the handle wins when djName is a usable handle', () => {
    expect(deriveUserPublicName('DJ Jazzy Jane', 'jane_dj')).toBe('DJ Jazzy Jane');
  });

  it('falls back to username when djName is absent', () => {
    expect(deriveUserPublicName(null, 'jane_dj')).toBe('jane_dj');
  });

  it('falls back to username when djName is the literal Anonymous', () => {
    expect(deriveUserPublicName('Anonymous', 'jane_dj')).toBe('jane_dj');
  });

  it('falls back to username when djName is blank', () => {
    expect(deriveUserPublicName('   ', 'jane_dj')).toBe('jane_dj');
  });

  // The documented micro-behavior change (BS#2297 review finding 1): a
  // whitespace-only username is trimmed and treated as blank, converging on
  // the mirror's documented contract (PR #2292). Unreachable via any current
  // writer — usernames validate against /^[a-zA-Z0-9_.]+$/ before reaching
  // this helper — so this only matters for a manually-edited legacy row.
  it('returns null when both djName and username are whitespace-only', () => {
    expect(deriveUserPublicName('  ', '   ')).toBeNull();
  });

  it('returns null when djName is absent and username is whitespace-only', () => {
    expect(deriveUserPublicName(null, '   ')).toBeNull();
  });

  it('returns null when neither djName nor username is usable', () => {
    expect(deriveUserPublicName(null, null)).toBeNull();
  });

  it('trims a valid username', () => {
    expect(deriveUserPublicName(null, '  jane_dj  ')).toBe('jane_dj');
  });
});
