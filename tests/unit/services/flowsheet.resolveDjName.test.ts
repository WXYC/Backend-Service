/**
 * Unit tests for the resolveDjNameForShow helper used by the live insert path
 * (step 5b.2) to denormalize the resolved DJ name onto each new flowsheet row.
 *
 * The helper must mirror the COALESCE priority used by both the search service
 * (DJ_NAME_EXPR) and migration 0053 backfill:
 *   COALESCE(auth_user.dj_name, shows.legacy_dj_name, auth_user.name)
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
