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

    // shows update (end_time)
    db.update.mockReturnValueOnce(createMockQueryChain([{}]));

    // getLatestShow() select chain — returns the show we just ended
    const latestShowSelect = createMockQueryChain();
    latestShowSelect.limit.mockResolvedValue([{ id: 42, end_time: new Date() }]);
    db.select.mockReturnValueOnce(latestShowSelect);

    await endShow({ id: 42, primary_dj_id: 'user-1' } as unknown as Parameters<typeof endShow>[0]);

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues).toEqual(
      expect.objectContaining({
        entry_type: 'show_end',
        dj_name: 'DJ Night Owl',
      })
    );
  });

  it('falls back to user.name when djName is null', async () => {
    const remainingDjsSelect = createMockQueryChain();
    remainingDjsSelect.where.mockResolvedValue([]);
    db.select.mockReturnValueOnce(remainingDjsSelect);

    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: null, name: 'Riley Owens' }]);
    db.select.mockReturnValueOnce(userSelect);

    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));

    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);
    db.update.mockReturnValueOnce(createMockQueryChain([{}]));

    const latestShowSelect = createMockQueryChain();
    latestShowSelect.limit.mockResolvedValue([{ id: 42, end_time: new Date() }]);
    db.select.mockReturnValueOnce(latestShowSelect);

    await endShow({ id: 42, primary_dj_id: 'user-1' } as unknown as Parameters<typeof endShow>[0]);

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues.dj_name).toBe('Riley Owens');
  });
});
