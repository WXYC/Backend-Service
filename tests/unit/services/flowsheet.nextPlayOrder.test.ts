/**
 * Regression guard for WXYC/Backend-Service#693.
 *
 * `nextPlayOrder()` originally took the global max(play_order) across the
 * entire `flowsheet` table and returned global_max + 1. With tubafrenzy's
 * webhook writing per-show play_orders (1, 2, 3, ...) and dj-site's adds going
 * through Backend-Service, a brand-new show would jump from per-show
 * play_order=4 (last tubafrenzy row) straight to play_order=471 (global max+1
 * pulled from a prior show's last entry). The discontinuity broke dj-site's
 * optimistic-update + cache reconciliation in `infinite-cache.ts`, surfacing
 * as "won't let me delete or reorder anything" for the on-air DJ.
 *
 * The fix scopes the max() to the row's own show via a `WHERE show_id = ?`
 * predicate. This test simulates the exact scenario from the issue:
 *   - Show A: per-show max play_order = 470
 *   - Show B (the one we're inserting into): per-show max play_order = 4
 * and asserts that an insert into show B picks 5 (B's max + 1), not 471
 * (A's global max + 1).
 *
 * The DB driver is mocked at chain granularity. We verify two things:
 *   1. The SELECT max chain receives a `where(...)` call (proving scope).
 *   2. The new row inserted via the INSERT chain carries play_order=5.
 */

import { db, createMockQueryChain } from '../../mocks/database.mock';
import { addTrack } from '../../../apps/backend/services/flowsheet.service';

describe('flowsheet.service: nextPlayOrder is scoped per show (#693)', () => {
  it("addTrack uses the new entry's show_id when computing play_order", async () => {
    // Show A has per-show max play_order=470 (from a prior on-air DJ's late
    // additions). Show B is the new one we're inserting into; its per-show
    // max is 4 (tubafrenzy webhook seeded it). The bug returned 471 here;
    // the fix returns 5.
    const SHOW_B_MAX = 4;

    // SELECT chain: returns the per-show max; the test verifies that .where()
    // was called on it (i.e. the query is scoped, not global).
    const selectChain = createMockQueryChain([{ max: SHOW_B_MAX }]);
    // The drizzle pattern is `await db.select().from().where()` — make the
    // chain awaitable so the await resolves to the per-show max.
    (selectChain as unknown as { then: (resolve: (v: unknown) => void) => void }).then = (
      resolve: (v: unknown) => void
    ) => resolve([{ max: SHOW_B_MAX }]);
    db.select.mockReturnValueOnce(selectChain);

    // INSERT chain: returns the inserted row so addTrack can return it.
    const insertReturnRow = { id: 12345, play_order: SHOW_B_MAX + 1, show_id: 1946734 };
    const insertChain = createMockQueryChain([insertReturnRow]);
    db.insert.mockReturnValueOnce(insertChain);

    const newEntry = {
      show_id: 1946734, // Show B (the one DJ Emily was on, per the issue body)
      entry_type: 'track' as const,
      artist_name: 'Motor City Drum Ensemble',
      album_title: 'L.O.V.E.',
      track_title: 'L.O.V.E.',
      record_label: 'Hot Wax',
      dj_name: 'DJ Emily',
    };

    const result = await addTrack(newEntry);

    // 1. The SELECT max query must be scoped by show_id. If `nextPlayOrder()`
    //    is still global, .where() is never called on the select chain.
    expect(selectChain.where).toHaveBeenCalled();

    // 2. The inserted row must carry play_order = SHOW_B_MAX + 1 = 5,
    //    not the global max + 1 (471 in the live incident).
    const insertedValues = insertChain.values.mock.calls[0]?.[0] as { play_order: number };
    expect(insertedValues.play_order).toBe(SHOW_B_MAX + 1);

    expect(result).toEqual(insertReturnRow);
  });
});
