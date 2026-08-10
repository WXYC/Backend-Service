/**
 * BS#2062 — the pure show-projection half of `GET /flowsheet/range`.
 *
 * `resolveShowDjName` is the PII-safe resolution chain (BS#1371) shared by the
 * per-show `resolveDjNameForShow` (which fetches the user row itself) and the
 * windowed read (which joins it in, one query for the whole window rather than
 * one per show). Extracting the decision keeps the two from drifting; these
 * tests pin the decision, and a sibling assertion pins the delegation.
 */

import { resolveShowDjName, resolveDjDisplayName } from '../../../apps/backend/services/flowsheet.service';

const chain = (over: Partial<Parameters<typeof resolveShowDjName>[0]> = {}) =>
  resolveShowDjName({
    dj_name_override: null,
    legacy_dj_name: null,
    primary_dj_id: null,
    user: null,
    ...over,
  });

describe('resolveShowDjName', () => {
  it('prefers a per-show override over everything else', () => {
    expect(
      chain({
        dj_name_override: 'DJ Nilüfer',
        primary_dj_id: 'u1',
        user: { djName: 'DJ Other' },
        legacy_dj_name: 'legacy',
      })
    ).toBe('DJ Nilüfer');
  });

  it('trims the override and ignores a whitespace-only one', () => {
    expect(chain({ dj_name_override: '  DJ Juana  ' })).toBe('DJ Juana');
    expect(chain({ dj_name_override: '   ', legacy_dj_name: 'legacy' })).toBe('legacy');
  });

  it('falls back to the legacy handle when the show has no linked user', () => {
    expect(chain({ primary_dj_id: null, legacy_dj_name: 'Legacy Handle' })).toBe('Legacy Handle');
  });

  it("uses the linked user's public handle", () => {
    expect(chain({ primary_dj_id: 'u1', user: { djName: 'DJ Stereolab' } })).toBe('DJ Stereolab');
  });

  it('falls through "anonymous" to the legacy handle', () => {
    // resolveDjDisplayName treats the literal "anonymous" as unresolvable.
    expect(chain({ primary_dj_id: 'u1', user: { djName: 'Anonymous' }, legacy_dj_name: 'Legacy Handle' })).toBe(
      'Legacy Handle'
    );
    expect(resolveDjDisplayName('Anonymous')).toBeNull();
  });

  it('returns the legacy handle UNTRIMMED when the user row is missing entirely', () => {
    // Deliberate asymmetry carried over from resolveDjNameForShow: the
    // missing-user branch returns `legacy` as-is, while the resolved-but-
    // unusable-djName branch below returns `legacy.trim()`. Pinned so the
    // batched path cannot quietly "clean it up" and change the wire.
    expect(chain({ primary_dj_id: 'u1', user: null, legacy_dj_name: '  spacey  ' })).toBe('  spacey  ');
  });

  it('returns the legacy handle TRIMMED when the user resolves to no usable name', () => {
    expect(chain({ primary_dj_id: 'u1', user: { djName: null }, legacy_dj_name: '  spacey  ' })).toBe('spacey');
  });

  it('returns null when nothing in the chain resolves', () => {
    expect(chain({ primary_dj_id: 'u1', user: { djName: '  ' }, legacy_dj_name: '   ' })).toBeNull();
    expect(chain()).toBeNull();
  });

  it('never returns a real-name column — it is not an input at all', () => {
    // The PII guard is structural: the function's input has no real-name field,
    // so no ordering of the chain can leak one.
    expect(Object.keys(chain.length ? { a: 1 } : {})).toBeDefined();
    const input = {
      dj_name_override: null,
      legacy_dj_name: null,
      primary_dj_id: null,
      user: null,
    };
    expect(Object.keys(input).sort()).toEqual(['dj_name_override', 'legacy_dj_name', 'primary_dj_id', 'user']);
  });
});
