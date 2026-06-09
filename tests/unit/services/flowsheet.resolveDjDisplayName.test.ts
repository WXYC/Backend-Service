/**
 * Unit tests for the resolveDjDisplayName helper extracted from the marker /
 * read sites in flowsheet.service.ts and flowsheet.controller.ts.
 *
 * The helper centralizes the rule: a DJ display name is "unresolvable" when
 * either the `djName` input is null/empty/whitespace, OR it's the literal
 * string `"Anonymous"` (case-insensitive, trim-tolerant).
 *
 * Background:
 *   - 2026-06-02 Aubrey Hearst on-air incident — the previous inline pattern
 *     `dj.djName || dj.name` rendered the literal `"Anonymous"` to the public
 *     on-air playlist when a DJ's `auth_user.dj_name` was the literal string
 *     (root cause traced to the better-auth anonymous-plugin path or a stale
 *     onboarding default). See WXYC/Backend-Service#1286 and the parent epic
 *     #1288 for the locked marker-text decisions this helper enforces.
 *   - BS#1371 follow-up — the prior signature `(djName, name) => string | null`
 *     fell back to `auth_user.name` when djName was unresolvable. But dj-site
 *     admin provisioning writes the user's real name into `auth_user.name`
 *     (`name: realName || username` in the roster UI), so the fallback was
 *     leaking PII onto the public v2 wire. The helper now uses only `djName`,
 *     and callers degrade to null when it's unresolvable.
 */
import { resolveDjDisplayName } from '../../../apps/backend/services/flowsheet.service';

describe('resolveDjDisplayName', () => {
  it('returns djName when present and not Anonymous', () => {
    expect(resolveDjDisplayName('DJ Stardust')).toBe('DJ Stardust');
  });

  it('returns null when djName is null', () => {
    expect(resolveDjDisplayName(null)).toBeNull();
  });

  it('returns null when djName is an empty string', () => {
    expect(resolveDjDisplayName('')).toBeNull();
  });

  it('returns null when djName is whitespace-only', () => {
    expect(resolveDjDisplayName('   ')).toBeNull();
  });

  it('returns null when djName is the literal "Anonymous"', () => {
    expect(resolveDjDisplayName('Anonymous')).toBeNull();
  });

  it('returns null when djName is "anonymous" (case-insensitive)', () => {
    expect(resolveDjDisplayName('anonymous')).toBeNull();
  });

  it('returns null when djName is "ANONYMOUS" (case-insensitive)', () => {
    expect(resolveDjDisplayName('ANONYMOUS')).toBeNull();
  });

  it('returns null when djName is "  Anonymous  " (trim + case)', () => {
    expect(resolveDjDisplayName('  Anonymous  ')).toBeNull();
  });

  it('does not strip "Anonymous" from a longer name (substring match must not fire)', () => {
    expect(resolveDjDisplayName('DJ Anonymous Mouse')).toBe('DJ Anonymous Mouse');
  });

  it('returns trimmed djName when valid (no surrounding whitespace bleed)', () => {
    expect(resolveDjDisplayName('  DJ Stardust  ')).toBe('DJ Stardust');
  });
});
