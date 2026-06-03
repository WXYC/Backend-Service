/**
 * Unit tests for the resolveDjDisplayName helper extracted from the six
 * marker / read sites in flowsheet.service.ts and flowsheet.controller.ts.
 *
 * The helper centralizes the rule: a DJ display name is "unresolvable" when
 * either both inputs are null/empty/whitespace OR the `djName` input is the
 * literal string `"Anonymous"` (case-insensitive, trim-tolerant).
 *
 * Background: 2026-06-02 Aubrey Hearst on-air incident — the previous inline
 * pattern `dj.djName || dj.name` rendered the literal `"Anonymous"` to the
 * public on-air playlist when a DJ's `auth_user.dj_name` was the literal
 * string (root cause traced to the better-auth anonymous-plugin path or a
 * stale onboarding default). See WXYC/Backend-Service#1286 and the parent
 * epic #1288 for the locked marker-text decisions this helper enforces.
 */
import { resolveDjDisplayName } from '../../../apps/backend/services/flowsheet.service';

describe('resolveDjDisplayName', () => {
  it('returns djName when both inputs are present and djName is not Anonymous', () => {
    expect(resolveDjDisplayName('DJ Stardust', 'Alex Stardust')).toBe('DJ Stardust');
  });

  it('falls back to name when djName is null', () => {
    expect(resolveDjDisplayName(null, 'Alex Stardust')).toBe('Alex Stardust');
  });

  it('falls back to name when djName is an empty string', () => {
    expect(resolveDjDisplayName('', 'Alex Stardust')).toBe('Alex Stardust');
  });

  it('falls back to name when djName is whitespace-only', () => {
    expect(resolveDjDisplayName('   ', 'Alex Stardust')).toBe('Alex Stardust');
  });

  it('returns null when both inputs are null', () => {
    expect(resolveDjDisplayName(null, null)).toBeNull();
  });

  it('returns null when both inputs are empty strings', () => {
    expect(resolveDjDisplayName('', '')).toBeNull();
  });

  it('returns null when both inputs are whitespace-only', () => {
    expect(resolveDjDisplayName('   ', '\t\n ')).toBeNull();
  });

  it('returns null when djName is the literal "Anonymous" and name is null', () => {
    expect(resolveDjDisplayName('Anonymous', null)).toBeNull();
  });

  it('returns null when djName is the literal "Anonymous" and name is empty', () => {
    expect(resolveDjDisplayName('Anonymous', '')).toBeNull();
  });

  it('returns null when djName is "anonymous" (case-insensitive)', () => {
    expect(resolveDjDisplayName('anonymous', null)).toBeNull();
  });

  it('returns null when djName is "ANONYMOUS" (case-insensitive)', () => {
    expect(resolveDjDisplayName('ANONYMOUS', null)).toBeNull();
  });

  it('returns null when djName is "  anonymous  " (trim + case)', () => {
    expect(resolveDjDisplayName('  Anonymous  ', null)).toBeNull();
  });

  it('returns name when djName is "Anonymous" but name is a real value (fallback past Anonymous)', () => {
    // Asymmetric design: if the user has a real `name`, prefer it over rendering
    // the public "Anonymous" string. This is the Aubrey Hearst incident path —
    // her auth_user.dj_name was "Anonymous" but better-auth `name` was empty,
    // so the marker correctly degrades to unresolvable.
    expect(resolveDjDisplayName('Anonymous', 'Aubrey Hearst')).toBe('Aubrey Hearst');
  });

  it('does not strip "Anonymous" from a longer name (substring match must not fire)', () => {
    expect(resolveDjDisplayName('DJ Anonymous Mouse', null)).toBe('DJ Anonymous Mouse');
  });

  it('returns trimmed djName when valid (no surrounding whitespace bleed)', () => {
    expect(resolveDjDisplayName('  DJ Stardust  ', null)).toBe('DJ Stardust');
  });

  it('returns trimmed name when name is the source of the value', () => {
    expect(resolveDjDisplayName(null, '  Alex Stardust  ')).toBe('Alex Stardust');
  });
});
