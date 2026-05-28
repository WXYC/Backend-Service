/**
 * Unit tests for jobs/rotation-release-id-backfill writer.ts (BS#1029).
 *
 * The writer translates an in-memory (rotation_id, release_id) pair into a
 * single UPDATE … WHERE discogs_release_id IS NULL. The WHERE clause is the
 * race guard: if a tubafrenzy paste landed mid-run, the UPDATE affects 0
 * rows and the writer reports `written: false` so the orchestrator can
 * surface it on its `raced` counter (BS#1029 acceptance criterion).
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import { writeReleaseId } from '../../../../jobs/rotation-release-id-backfill/writer';

type MockChain = Record<string, jest.Mock>;
const chain = (db as unknown as { _chain: MockChain })._chain;

describe('writeReleaseId', () => {
  beforeEach(() => {
    chain.returning.mockReset();
  });

  test('returns written:true when the UPDATE affects one row (resolved happy path)', async () => {
    chain.returning.mockResolvedValueOnce([{ id: 42 }]);

    const result = await writeReleaseId(42, 999001);

    expect(result).toEqual({ written: true });
    expect(chain.update).toHaveBeenCalled();
    const setCalls = chain.set.mock.calls;
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0][0]).toEqual({
      discogs_release_id: 999001,
      discogs_release_id_source: 'lml_offline_backfill',
    });
  });

  test('returns written:false when the UPDATE affects zero rows (race with tubafrenzy paste)', async () => {
    // The WHERE clause is `id = $1 AND discogs_release_id IS NULL`. If a
    // tubafrenzy paste landed between the orchestrator's SELECT and this
    // UPDATE, the row's discogs_release_id is no longer NULL and the
    // UPDATE matches zero rows. `.returning()` resolves to [].
    chain.returning.mockResolvedValueOnce([]);

    const result = await writeReleaseId(42, 999001);

    expect(result).toEqual({ written: false });
  });
});
