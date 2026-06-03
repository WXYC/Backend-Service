/**
 * Unit tests for the resolveDjNameForShow helper used by the live insert path
 * (step 5b.2) to denormalize the resolved DJ name onto each new flowsheet row.
 *
 * Priority after BS#1321 (migration 0090):
 *   1. shows.dj_name_override (per-show operator-intent override)
 *   2. auth_user.dj_name (Anonymous-filtered)
 *   3. shows.legacy_dj_name (tubafrenzy-owned fallback)
 *   4. auth_user.name
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import { resolveDjNameForShow } from '../../../apps/backend/services/flowsheet.service';

const mockDb = db as unknown as { _chain: Record<string, jest.Mock> };
const chain = mockDb._chain;

const setUserLookupResult = (rows: Array<{ djName: string | null; name: string | null }>) => {
  // The user lookup ends in `.limit(1)`; configure it to resolve to `rows`.
  chain.limit.mockResolvedValueOnce(rows);
};

describe('resolveDjNameForShow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when the show has no primary_dj_id and no legacy_dj_name', async () => {
    const result = await resolveDjNameForShow({ id: 1, primary_dj_id: null, legacy_dj_name: null } as any);
    expect(result).toBeNull();
  });

  it('returns shows.legacy_dj_name when there is no primary_dj_id', async () => {
    const result = await resolveDjNameForShow({
      id: 1,
      primary_dj_id: null,
      legacy_dj_name: 'DJ Bluejay',
    } as any);
    expect(result).toBe('DJ Bluejay');
  });

  it('prefers user.djName over legacy_dj_name and user.name', async () => {
    setUserLookupResult([{ djName: 'DJ Stardust', name: 'Alex Stardust' }]);
    const result = await resolveDjNameForShow({
      id: 1,
      primary_dj_id: 'user-1',
      legacy_dj_name: 'OldName',
    } as any);
    expect(result).toBe('DJ Stardust');
  });

  it('falls back to legacy_dj_name when user.djName is null', async () => {
    setUserLookupResult([{ djName: null, name: 'Alex Stardust' }]);
    const result = await resolveDjNameForShow({
      id: 1,
      primary_dj_id: 'user-1',
      legacy_dj_name: 'Legacy DJ Name',
    } as any);
    expect(result).toBe('Legacy DJ Name');
  });

  it('falls back to user.name when both djName and legacy_dj_name are null', async () => {
    setUserLookupResult([{ djName: null, name: 'Alex Stardust' }]);
    const result = await resolveDjNameForShow({
      id: 1,
      primary_dj_id: 'user-1',
      legacy_dj_name: null,
    } as any);
    expect(result).toBe('Alex Stardust');
  });

  it('returns legacy_dj_name when the user lookup yields no row', async () => {
    setUserLookupResult([]);
    const result = await resolveDjNameForShow({
      id: 1,
      primary_dj_id: 'missing-user',
      legacy_dj_name: 'Fallback',
    } as any);
    expect(result).toBe('Fallback');
  });
});

/**
 * BS#1321 — `shows.dj_name_override` is the top of the precedence chain.
 * Promotes BS#1295's marker-only stamp into a durable per-show field, so
 * every track row added via `addEntry` after `startShow` reflects the
 * override too — fixing the within-show inconsistency C1 raised on PR #1320.
 *
 * The override short-circuits before the user lookup runs at all — no DB
 * round-trip on the SELECT chain when the override is set.
 */
describe('resolveDjNameForShow with dj_name_override (BS#1321)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prefers dj_name_override over user.djName, legacy_dj_name, and user.name', async () => {
    // Critical case from issue #1321: DJ has a non-Anonymous `auth_user.dj_name`,
    // and operator set an override on join. Without BS#1321 the user.djName
    // branch wins → marker says "Aubrey Hearst" but track rows say
    // "DJ Stardust". The user lookup must NOT be consulted; if it were
    // mocked here, the test would still pass because override comes first —
    // but configuring the chain helps catch regressions where override
    // promotion is removed and the resolver silently falls through.
    setUserLookupResult([{ djName: 'DJ Stardust', name: 'Alex Stardust' }]);
    const result = await resolveDjNameForShow({
      id: 1,
      primary_dj_id: 'user-1',
      dj_name_override: 'Aubrey Hearst',
      legacy_dj_name: 'Some Legacy Name',
    } as any);
    expect(result).toBe('Aubrey Hearst');
  });

  it('prefers dj_name_override even when primary_dj_id is null', async () => {
    // Tubafrenzy-originated shows can carry NULL primary_dj_id; the override
    // path must still work for the (admittedly unusual but possible) case
    // where an operator sets one on such a show.
    const result = await resolveDjNameForShow({
      id: 1,
      primary_dj_id: null,
      dj_name_override: 'Guest Host',
      legacy_dj_name: 'tubafrenzy name',
    } as any);
    expect(result).toBe('Guest Host');
  });

  it('trims whitespace from the override before returning', async () => {
    const result = await resolveDjNameForShow({
      id: 1,
      primary_dj_id: 'user-1',
      dj_name_override: '   Aubrey Hearst   ',
    } as any);
    expect(result).toBe('Aubrey Hearst');
  });

  it('treats whitespace-only override as absent — falls through to user.djName', async () => {
    setUserLookupResult([{ djName: 'DJ Stardust', name: 'Alex Stardust' }]);
    const result = await resolveDjNameForShow({
      id: 1,
      primary_dj_id: 'user-1',
      dj_name_override: '   ',
      legacy_dj_name: null,
    } as any);
    expect(result).toBe('DJ Stardust');
  });

  it('treats null override as absent — falls through to user.djName', async () => {
    setUserLookupResult([{ djName: 'DJ Stardust', name: 'Alex Stardust' }]);
    const result = await resolveDjNameForShow({
      id: 1,
      primary_dj_id: 'user-1',
      dj_name_override: null,
      legacy_dj_name: null,
    } as any);
    expect(result).toBe('DJ Stardust');
  });

  it('returns the override even when it matches the literal "Anonymous"', async () => {
    // The Anonymous-filtering rule applies to auth_user.dj_name (a workaround
    // for an upstream onboarding bug that wrote "Anonymous" automatically),
    // NOT to the operator-supplied override. If the operator typed
    // "Anonymous" into the override field, they chose that string on
    // purpose — trust it verbatim.
    const result = await resolveDjNameForShow({
      id: 1,
      primary_dj_id: 'user-1',
      dj_name_override: 'Anonymous',
    } as any);
    expect(result).toBe('Anonymous');
  });
});
