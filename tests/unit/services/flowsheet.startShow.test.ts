import { db, createMockQueryChain } from '../../mocks/database.mock';
import { startShow } from '../../../apps/backend/services/flowsheet.service';

// nextPlayOrder() does `await db.select(...).from(...).where(...)` — no .returning() —
// so the chain itself must resolve to the max-row result.
const makeAwaitablePlayOrderChain = (max: number) => {
  const chain = createMockQueryChain();
  (chain as unknown as { then: (resolve: (v: unknown) => void) => void }).then = (resolve) => resolve([{ max }]);
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

/**
 * dj_name_override coverage for the 2026-06-02 Aubrey Hearst incident
 * follow-up (WXYC/Backend-Service#1295, epic #1288). Override is per-call,
 * trumps `auth_user.dj_name`/`auth_user.name` for the show_start marker text,
 * the `flowsheet.dj_name` column, and the new `shows.legacy_dj_name` column.
 *
 * Empty / whitespace-only override is treated as absent — today's
 * resolveDjDisplayName fallback path must remain the only behavior change
 * is opt-in.
 */
describe('startShow dj_name_override (BS#1295)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Mocks: user lookup, shows insert (returning), show_djs insert,
  // nextPlayOrder select, flowsheet insert. Mirrors the setUp helper in
  // the markerText suite — duplicated here so this suite is self-contained.
  const setUpForStartShow = (djName: string | null, name: string | null) => {
    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName, name }]);
    db.select.mockReturnValueOnce(userSelect);

    const showsInsert = createMockQueryChain([{ id: 42 }]);
    db.insert.mockReturnValueOnce(showsInsert);
    db.insert.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-1' }]));
    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));
    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);

    return { showsInsert, flowsheetInsert };
  };

  it('uses the override for marker text + flowsheet.dj_name regardless of auth_user.dj_name', async () => {
    // auth_user holds the literal "Anonymous" from the Aubrey Hearst incident
    // root cause; without the override this would fall back to user.name.
    const { showsInsert, flowsheetInsert } = setUpForStartShow('Anonymous', 'maura-real-name');

    await startShow('user-1', undefined, undefined, 'Aubrey Hearst');

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues.dj_name).toBe('Aubrey Hearst');
    expect(flowsheetValues.message).toMatch(/^Start of Show: Aubrey Hearst joined the set at /);
    // AC#4: shows.legacy_dj_name populated to match the marker name when override present.
    const showsValues = showsInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(showsValues.legacy_dj_name).toBe('Aubrey Hearst');
  });

  it('trims whitespace from the override before persisting', async () => {
    const { showsInsert, flowsheetInsert } = setUpForStartShow('DJ Stardust', 'Alex Stardust');

    await startShow('user-1', undefined, undefined, '  Aubrey Hearst  ');

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues.dj_name).toBe('Aubrey Hearst');
    expect(flowsheetValues.message).toMatch(/^Start of Show: Aubrey Hearst joined the set at /);
    const showsValues = showsInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(showsValues.legacy_dj_name).toBe('Aubrey Hearst');
  });

  it('treats empty-string override as absent — falls back to auth_user.dj_name', async () => {
    const { showsInsert, flowsheetInsert } = setUpForStartShow('DJ Stardust', 'Alex Stardust');

    await startShow('user-1', undefined, undefined, '');

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues.dj_name).toBe('DJ Stardust');
    expect(flowsheetValues.message).toMatch(/^Start of Show: DJ Stardust joined the set at /);
    // No override → legacy_dj_name stays null (preserves pre-#1295 shape).
    const showsValues = showsInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(showsValues.legacy_dj_name ?? null).toBeNull();
  });

  it('treats whitespace-only override as absent — falls back to auth_user.dj_name', async () => {
    const { showsInsert, flowsheetInsert } = setUpForStartShow('DJ Stardust', 'Alex Stardust');

    await startShow('user-1', undefined, undefined, '   ');

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues.dj_name).toBe('DJ Stardust');
    const showsValues = showsInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(showsValues.legacy_dj_name ?? null).toBeNull();
  });

  it('absent override (undefined) produces the same shape as pre-#1295 — no regression', async () => {
    const { showsInsert, flowsheetInsert } = setUpForStartShow('DJ Stardust', 'Alex Stardust');

    await startShow('user-1', 'Some Show', 7);

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues.dj_name).toBe('DJ Stardust');
    expect(flowsheetValues.message).toMatch(/^Start of Show: DJ Stardust joined the set at /);
    const showsValues = showsInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(showsValues.show_name).toBe('Some Show');
    expect(showsValues.specialty_id).toBe(7);
    expect(showsValues.legacy_dj_name ?? null).toBeNull();
  });

  it('does not touch show_name / specialty_id plumbing when override is present', async () => {
    const { showsInsert } = setUpForStartShow('DJ Stardust', 'Alex Stardust');

    await startShow('user-1', 'Some Show', 7, 'Aubrey Hearst');

    const showsValues = showsInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(showsValues.show_name).toBe('Some Show');
    expect(showsValues.specialty_id).toBe(7);
    expect(showsValues.legacy_dj_name).toBe('Aubrey Hearst');
  });
});
