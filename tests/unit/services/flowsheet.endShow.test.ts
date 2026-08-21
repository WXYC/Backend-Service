import { db, createMockQueryChain } from '../../mocks/database.mock';
import { endShow } from '../../../apps/backend/services/flowsheet.service';

const makeAwaitablePlayOrderChain = (max: number) => {
  const chain = createMockQueryChain();
  (chain as unknown as { then: (resolve: (v: unknown) => void) => void }).then = (resolve) => resolve([{ max }]);
  return chain;
};

describe('endShow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists dj_name (from user.djName) on the show_end flowsheet row', async () => {
    // remaining_djs select — no guests so the loop is a no-op
    const remainingDjsSelect = createMockQueryChain();
    remainingDjsSelect.where.mockResolvedValue([]);
    db.select.mockReturnValueOnce(remainingDjsSelect);

    // primary DJ user lookup
    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: 'DJ Night Owl', name: 'Riley Owens' }]);
    db.select.mockReturnValueOnce(userSelect);

    // nextPlayOrder select for the flowsheet insert
    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(7));

    // flowsheet insert — inspection target
    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);

    // shows update (end_time) — the compare-and-set that claims the show. It
    // runs FIRST now, and endShow returns its .returning() row directly (no
    // getLatestShow re-read; BS#1119 follow-up)
    db.update.mockReturnValueOnce(createMockQueryChain([{ id: 42, end_time: new Date() }]));

    await endShow({ id: 42, primary_dj_id: 'user-1' } as unknown as Parameters<typeof endShow>[0]);

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues).toEqual(
      expect.objectContaining({
        entry_type: 'show_end',
        dj_name: 'DJ Night Owl',
      })
    );
  });

  it('persists null dj_name when djName is null — never leaks auth_user.name (BS#1371 PII)', async () => {
    const remainingDjsSelect = createMockQueryChain();
    remainingDjsSelect.where.mockResolvedValue([]);
    db.select.mockReturnValueOnce(remainingDjsSelect);

    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: null, name: 'Riley Owens (real name)' }]);
    db.select.mockReturnValueOnce(userSelect);

    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));

    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);
    db.update.mockReturnValueOnce(createMockQueryChain([{ id: 42, end_time: new Date() }]));

    await endShow({ id: 42, primary_dj_id: 'user-1' } as unknown as Parameters<typeof endShow>[0]);

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    // show_end row is kept (the show ended) but dj_name is null; endShow's
    // asymmetric-fallback emits the degraded message body.
    expect(flowsheetValues.dj_name).toBeNull();
  });

  /**
   * BS#2093, decided by BS#2235. This used to `throw new Error('Primary DJ not
   * found')`, which made a NULL-primary show permanently un-endable — and
   * `shows.primary_dj_id` is `onDelete: 'set null'`, so deleting a DJ's
   * account orphans every show they ran. The legacy ETL cohort is the bulk of
   * it: 2,813 of production's 2,814 open shows carried NULL here on
   * 2026-08-21, and they are exactly what `POST /flowsheet/shows/:id/force-end`
   * exists to close.
   */
  it('ends a show whose primary_dj_id is NULL, with the degraded marker wording', async () => {
    const remainingDjsSelect = createMockQueryChain();
    remainingDjsSelect.where.mockResolvedValue([]);
    db.select.mockReturnValueOnce(remainingDjsSelect);

    // No user lookup happens on this path — there is no id to look up — so the
    // next select the implementation reaches for is nextPlayOrder's.
    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(3));

    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);
    db.update.mockReturnValueOnce(createMockQueryChain([{ id: 74840, end_time: new Date() }]));

    const finalized = await endShow({
      id: 74840,
      primary_dj_id: null,
    } as unknown as Parameters<typeof endShow>[0]);

    expect(finalized).toMatchObject({ id: 74840 });

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues).toEqual(expect.objectContaining({ entry_type: 'show_end', show_id: 74840, dj_name: null }));
    // The name-less template, same one an unresolvable djName produces.
    expect(flowsheetValues.message).toMatch(/^End of show: /);
  });

  it('deactivates every show_djs row when primary_dj_id is NULL', async () => {
    // The loop skips the primary so it does not write itself a leave marker.
    // With a NULL primary, `dj.dj_id === primary_dj_id` is false for every row
    // (dj_id is NOT NULL), so every membership deactivates and every co-host
    // gets a leave marker — correct for an ownerless show.
    const remainingDjsSelect = createMockQueryChain();
    remainingDjsSelect.where.mockResolvedValue([{ show_id: 74840, dj_id: 'guest-1', active: true }]);
    db.select.mockReturnValueOnce(remainingDjsSelect);

    // createLeaveNotification: user lookup, then nextPlayOrder, then insert.
    const guestUserSelect = createMockQueryChain();
    guestUserSelect.limit.mockResolvedValue([{ djName: 'DJ Guest' }]);
    db.select.mockReturnValueOnce(guestUserSelect);
    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(1));
    const leaveInsert = createMockQueryChain([{ id: 111 }]);
    db.insert.mockReturnValueOnce(leaveInsert);

    // Then the show_end marker's own nextPlayOrder + insert.
    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(2));
    db.insert.mockReturnValueOnce(createMockQueryChain([{ id: 999 }]));

    const showDjsUpdate = createMockQueryChain([{ show_id: 74840, dj_id: 'guest-1', active: false }]);
    db.update.mockReturnValueOnce(createMockQueryChain([{ id: 74840, end_time: new Date() }]));
    db.update.mockReturnValueOnce(showDjsUpdate);

    await endShow({ id: 74840, primary_dj_id: null } as unknown as Parameters<typeof endShow>[0]);

    expect(showDjsUpdate.set).toHaveBeenCalledWith({ active: false });
    expect(leaveInsert.values).toHaveBeenCalledWith(expect.objectContaining({ entry_type: 'dj_leave' }));
  });

  it('rejects the loser of a concurrent double-end without writing a second show_end marker', async () => {
    // The end_time UPDATE is a compare-and-set (`WHERE id = ? AND end_time IS
    // NULL`) and runs FIRST, before any other write. The controller's own
    // `end_time !== null` guard only rejects a second end after the first
    // COMMITS — a double-click has both requests reading a live show, and
    // without the CAS both wrote a marker and both returned 200, so the mirror
    // signed tubafrenzy off twice. An empty `.returning()` is the loser.
    db.update.mockReturnValueOnce(createMockQueryChain([]));

    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);

    await expect(
      endShow({ id: 42, primary_dj_id: 'user-1' } as unknown as Parameters<typeof endShow>[0])
    ).rejects.toMatchObject({ statusCode: 400 });

    // Claiming the show comes before every other write, so the loser leaves no
    // trace at all: no second show_end marker, no guest-DJ deactivation.
    expect(flowsheetInsert.values).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});
