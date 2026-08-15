/**
 * Unit tests for uncovered-release-list's markers.ts (BS#1877): the
 * "searched, found nothing" marker writer. `db` is mocked via
 * `tests/mocks/database.mock.ts` (same `_chain` inspection idiom as
 * `album-critic-reviews-etl/writer.test.ts`) — pins that the UPSERT
 * conflicts on `album_id` (the table's real unique index, migration 0133)
 * and that a repeat handoff bumps `handoff_count` / refreshes
 * `last_handed_off_at` rather than silently no-op'ing.
 */
import { db } from '@wxyc/database';
import { recordHandoffs } from '../../../../jobs/uncovered-release-list/markers';

type MockDb = typeof db & {
  _chain: {
    returning: jest.Mock;
    onConflictDoUpdate: jest.Mock;
    values: jest.Mock;
    insert: jest.Mock;
  };
};

const mockDb = db as MockDb;

const upsertConfig = (): { target?: unknown; set?: Record<string, unknown> } =>
  mockDb._chain.onConflictDoUpdate.mock.calls[0]?.[0] as ReturnType<typeof upsertConfig>;

describe('recordHandoffs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('short-circuits to 0 without a DB round-trip for empty input', async () => {
    const count = await recordHandoffs([]);
    expect(count).toBe(0);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('inserts one row per library id and returns the written count', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const count = await recordHandoffs([10, 20, 30]);

    expect(count).toBe(3);
    expect(mockDb._chain.values).toHaveBeenCalledWith([{ album_id: 10 }, { album_id: 20 }, { album_id: 30 }]);
  });

  it('conflicts on album_id (the migration-0133 unique index)', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1 }]);
    await recordHandoffs([10]);
    expect(upsertConfig().target).toBe('album_id'); // the mock table maps columns to their names
  });

  it('a repeat handoff refreshes last_handed_off_at and bumps handoff_count rather than a no-op', async () => {
    mockDb._chain.returning.mockResolvedValueOnce([{ id: 1 }]);
    await recordHandoffs([10]);
    const set = upsertConfig().set;
    expect(set).toHaveProperty('last_handed_off_at');
    expect(set).toHaveProperty('handoff_count');
  });
});
