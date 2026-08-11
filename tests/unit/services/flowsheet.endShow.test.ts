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
