import { db, createMockQueryChain } from '../../mocks/database.mock';
import { startShow } from '../../../apps/backend/services/flowsheet.service';

// nextPlayOrder() does `await db.select(...).from(...).where(...)` — no .returning() —
// so the chain itself must resolve to the max-row result.
const makeAwaitablePlayOrderChain = (max: number) => {
  const chain = createMockQueryChain();
  (chain as unknown as { then: (resolve: (v: unknown) => void) => void }).then = (resolve) =>
    resolve([{ max }]);
  return chain;
};

describe('startShow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws a 404 error before inserting a show when the DJ does not exist', async () => {
    const selectChain = createMockQueryChain();
    selectChain.limit.mockResolvedValue([]);
    db.select.mockReturnValue(selectChain);

    await expect(startShow('nonexistent-dj-id')).rejects.toThrow('not found');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('persists dj_name (from user.djName) on the show_start flowsheet row', async () => {
    // user lookup
    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: 'DJ Stardust', name: 'Alex Stardust' }]);
    db.select.mockReturnValueOnce(userSelect);

    // shows insert returns the new show id
    const showsInsert = createMockQueryChain([{ id: 42 }]);
    db.insert.mockReturnValueOnce(showsInsert);

    // show_djs insert
    db.insert.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-1' }]));

    // nextPlayOrder select
    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));

    // flowsheet insert — this is the call we want to inspect
    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);

    await startShow('user-1', 'Some Show');

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues).toEqual(
      expect.objectContaining({
        entry_type: 'show_start',
        dj_name: 'DJ Stardust',
      })
    );
  });

  it('falls back to user.name when djName is null', async () => {
    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: null, name: 'Alex Stardust' }]);
    db.select.mockReturnValueOnce(userSelect);

    db.insert.mockReturnValueOnce(createMockQueryChain([{ id: 42 }]));
    db.insert.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-1' }]));
    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));

    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);

    await startShow('user-1');

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues.dj_name).toBe('Alex Stardust');
  });

  it('persists null dj_name when the user has neither djName nor name', async () => {
    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: null, name: null }]);
    db.select.mockReturnValueOnce(userSelect);

    db.insert.mockReturnValueOnce(createMockQueryChain([{ id: 42 }]));
    db.insert.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-1' }]));
    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));

    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);

    await startShow('user-1');

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues.dj_name).toBeNull();
  });
});
