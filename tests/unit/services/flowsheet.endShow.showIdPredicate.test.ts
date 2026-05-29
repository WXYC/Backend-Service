import { db, createMockQueryChain, show_djs } from '../../mocks/database.mock';
import { endShow } from '../../../apps/backend/services/flowsheet.service';

/**
 * Regression test for #1100: `endShow` must scope its `show_djs.active=false`
 * UPDATE by `(show_id, dj_id)`, not by `dj_id` alone. Without the show_id
 * predicate, every `show_djs` row for that DJ across all of their historical
 * shows gets flipped to inactive. Mirrors `leaveShow`'s correctly-scoped
 * predicate shape.
 */

const makeAwaitablePlayOrderChain = (max: number) => {
  const chain = createMockQueryChain();
  (chain as unknown as { then: (resolve: (v: unknown) => void) => void }).then = (resolve) => resolve([{ max }]);
  return chain;
};

describe('endShow show_djs UPDATE predicate (#1100)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scopes show_djs.active=false UPDATE to (show_id=current, dj_id), leaving prior shows untouched', async () => {
    const PRIOR_SHOW_ID = 1;
    const CURRENT_SHOW_ID = 2;
    const DJ_ID = 'dj-A';

    // remaining_djs SELECT — DJ A is the only active member of show 2. The
    // prior-show row (show 1) is not returned because the SELECT already
    // filters by show_id, and isn't needed for the assertion either: the
    // per-DJ UPDATE's predicate is derived from `currentShow.id`, so the
    // contract we're verifying is that the captured WHERE clause carries
    // `show_id = current` (and therefore PostgreSQL will skip show 1's row).
    const remainingDjsSelect = createMockQueryChain();
    remainingDjsSelect.where.mockResolvedValue([{ show_id: CURRENT_SHOW_ID, dj_id: DJ_ID, active: true }]);
    db.select.mockReturnValueOnce(remainingDjsSelect);

    // show_djs UPDATE chain — inspection target.
    const showDjsUpdate = createMockQueryChain();
    db.update.mockReturnValueOnce(showDjsUpdate);

    // primary DJ user lookup; DJ A is the primary so the loop skips
    // createLeaveNotification.
    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: 'DJ A', name: 'A' }]);
    db.select.mockReturnValueOnce(userSelect);

    // nextPlayOrder for the show_end insert
    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));
    // flowsheet insert (show_end)
    db.insert.mockReturnValueOnce(createMockQueryChain([{ id: 999 }]));
    // shows update (end_time)
    db.update.mockReturnValueOnce(createMockQueryChain([{}]));
    // getLatestShow()
    const latestShowSelect = createMockQueryChain();
    latestShowSelect.limit.mockResolvedValue([{ id: CURRENT_SHOW_ID, end_time: new Date() }]);
    db.select.mockReturnValueOnce(latestShowSelect);

    await endShow({ id: CURRENT_SHOW_ID, primary_dj_id: DJ_ID } as unknown as Parameters<typeof endShow>[0]);

    // The first call to showDjsUpdate.where is the per-DJ UPDATE inside the
    // Promise.all loop. Assert it constrains both show_id and dj_id — and
    // that show_id is bound to the current show, not a prior one.
    const wherePredicate = showDjsUpdate.where.mock.calls[0]?.[0] as {
      and: Array<{ eq: [unknown, unknown] }>;
    };

    expect(wherePredicate).toEqual({
      and: expect.arrayContaining([{ eq: [show_djs.show_id, CURRENT_SHOW_ID] }, { eq: [show_djs.dj_id, DJ_ID] }]),
    });
    expect(wherePredicate.and).toHaveLength(2);
    expect(wherePredicate.and).not.toContainEqual({ eq: [show_djs.show_id, PRIOR_SHOW_ID] });
  });
});
