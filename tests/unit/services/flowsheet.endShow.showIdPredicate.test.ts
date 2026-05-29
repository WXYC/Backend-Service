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

  it('scopes show_djs.active=false UPDATE to (show_id, dj_id), not dj_id alone', async () => {
    const CURRENT_SHOW_ID = 2;
    const DJ_ID = 'dj-A';

    // DJ A is the remaining-active row on show 2; the mock returns this as the
    // only row the loop will iterate over. The DJ is also the primary DJ, so
    // the loop skips the leave-notification branch.
    const remainingDjsSelect = createMockQueryChain();
    remainingDjsSelect.where.mockResolvedValue([{ show_id: CURRENT_SHOW_ID, dj_id: DJ_ID, active: true }]);
    db.select.mockReturnValueOnce(remainingDjsSelect);

    // show_djs UPDATE chain — inspection target.
    const showDjsUpdate = createMockQueryChain();
    db.update.mockReturnValueOnce(showDjsUpdate);

    // primary DJ user lookup (after the loop)
    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: 'DJ A', name: 'A' }]);
    db.select.mockReturnValueOnce(userSelect);

    // nextPlayOrder for the show_end insert
    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));

    // flowsheet insert (show_end)
    db.insert.mockReturnValueOnce(createMockQueryChain([{ id: 999 }]));

    // shows update (end_time)
    db.update.mockReturnValueOnce(createMockQueryChain([{}]));

    // getLatestShow() select chain
    const latestShowSelect = createMockQueryChain();
    latestShowSelect.limit.mockResolvedValue([{ id: CURRENT_SHOW_ID, end_time: new Date() }]);
    db.select.mockReturnValueOnce(latestShowSelect);

    await endShow({ id: CURRENT_SHOW_ID, primary_dj_id: DJ_ID } as unknown as Parameters<typeof endShow>[0]);

    // The first call to showDjsUpdate.where is the per-DJ UPDATE inside the
    // Promise.all loop. Assert it constrains both show_id and dj_id.
    const wherePredicate = showDjsUpdate.where.mock.calls[0]?.[0] as {
      and: Array<{ eq: [unknown, unknown] }>;
    };

    expect(wherePredicate).toEqual({
      and: expect.arrayContaining([{ eq: [show_djs.show_id, CURRENT_SHOW_ID] }, { eq: [show_djs.dj_id, DJ_ID] }]),
    });
    expect(wherePredicate.and).toHaveLength(2);
  });

  it("does not flip a DJ's prior-show row when ending a later show", async () => {
    // Sanity-check the contract from the other side: with the show_id
    // predicate in place, a DJ who has active=true rows on shows 1 AND 2
    // should only see show 2's row flipped when endShow(show2) runs. The
    // UPDATE's WHERE clause carries the current show id; show 1's row is
    // untouched because the predicate excludes it. We model that by
    // asserting the captured predicate's show_id value equals the current
    // show id and never the prior one.
    const PRIOR_SHOW_ID = 1;
    const CURRENT_SHOW_ID = 2;
    const DJ_ID = 'dj-A';

    const remainingDjsSelect = createMockQueryChain();
    remainingDjsSelect.where.mockResolvedValue([{ show_id: CURRENT_SHOW_ID, dj_id: DJ_ID, active: true }]);
    db.select.mockReturnValueOnce(remainingDjsSelect);

    const showDjsUpdate = createMockQueryChain();
    db.update.mockReturnValueOnce(showDjsUpdate);

    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: 'DJ A', name: 'A' }]);
    db.select.mockReturnValueOnce(userSelect);

    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));
    db.insert.mockReturnValueOnce(createMockQueryChain([{ id: 999 }]));
    db.update.mockReturnValueOnce(createMockQueryChain([{}]));

    const latestShowSelect = createMockQueryChain();
    latestShowSelect.limit.mockResolvedValue([{ id: CURRENT_SHOW_ID, end_time: new Date() }]);
    db.select.mockReturnValueOnce(latestShowSelect);

    await endShow({ id: CURRENT_SHOW_ID, primary_dj_id: DJ_ID } as unknown as Parameters<typeof endShow>[0]);

    const wherePredicate = showDjsUpdate.where.mock.calls[0]?.[0] as {
      and: Array<{ eq: [unknown, unknown] }>;
    };
    const showIdPredicate = wherePredicate.and.find(
      (clause) => Array.isArray(clause.eq) && clause.eq[0] === show_djs.show_id
    );
    expect(showIdPredicate?.eq[1]).toBe(CURRENT_SHOW_ID);
    expect(showIdPredicate?.eq[1]).not.toBe(PRIOR_SHOW_ID);
  });
});
