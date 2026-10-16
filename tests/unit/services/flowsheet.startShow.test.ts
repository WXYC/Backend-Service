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

  it('persists null dj_name when djName is null — never leaks auth_user.name (BS#1371 PII)', async () => {
    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: null, name: 'Alex Stardust (real name)' }]);
    db.select.mockReturnValueOnce(userSelect);

    db.insert.mockReturnValueOnce(createMockQueryChain([{ id: 42 }]));
    db.insert.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-1' }]));
    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));

    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);

    await startShow('user-1');

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    // The show_start row is kept (the show happened) but dj_name is null;
    // startShow's asymmetric-fallback emits the degraded message body.
    expect(flowsheetValues.dj_name).toBeNull();
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
 * follow-up (WXYC/Backend-Service#1295 → #1321, epic #1288). Override is
 * per-call, trumps `auth_user.dj_name`/`auth_user.name` for the show_start
 * marker text, the `flowsheet.dj_name` column, and the new
 * `shows.dj_name_override` column (migration 0090).
 *
 * BS#1321 redirects the persistence target from `shows.legacy_dj_name` to
 * a dedicated `shows.dj_name_override` column. `legacy_dj_name` is owned by
 * the tubafrenzy ETL upsert (`jobs/flowsheet-etl/job.ts` overwrites it on
 * every sync tick), so an override written there only survived until the
 * next sync window. The new column is Backend-Service-only and is checked
 * at the top of `resolveDjNameForShow`'s precedence chain so every
 * subsequent track row added via `addEntry` also reflects it.
 *
 * Empty / whitespace-only override is treated as absent — today's
 * resolveDjDisplayName fallback path must remain the only behavior change
 * is opt-in.
 */
describe('startShow dj_name_override (BS#1295 → BS#1321)', () => {
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
    // AC#4: shows.dj_name_override populated to match the marker name (BS#1321).
    // BS#1321: the override no longer lands on `shows.legacy_dj_name` — that
    // column is upstream-owned (tubafrenzy ETL). The dedicated override
    // column is the durable, ETL-safe persistence target.
    const showsValues = showsInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(showsValues.dj_name_override).toBe('Aubrey Hearst');
    expect(showsValues.legacy_dj_name).toBeUndefined();
  });

  it('trims whitespace from the override before persisting', async () => {
    const { showsInsert, flowsheetInsert } = setUpForStartShow('DJ Stardust', 'Alex Stardust');

    await startShow('user-1', undefined, undefined, '  Aubrey Hearst  ');

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues.dj_name).toBe('Aubrey Hearst');
    expect(flowsheetValues.message).toMatch(/^Start of Show: Aubrey Hearst joined the set at /);
    const showsValues = showsInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(showsValues.dj_name_override).toBe('Aubrey Hearst');
  });

  it('treats empty-string override as absent — falls back to auth_user.dj_name', async () => {
    const { showsInsert, flowsheetInsert } = setUpForStartShow('DJ Stardust', 'Alex Stardust');

    await startShow('user-1', undefined, undefined, '');

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues.dj_name).toBe('DJ Stardust');
    expect(flowsheetValues.message).toMatch(/^Start of Show: DJ Stardust joined the set at /);
    // No override → dj_name_override stays null (preserves pre-#1295 shape).
    const showsValues = showsInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(showsValues.dj_name_override ?? null).toBeNull();
  });

  it('treats whitespace-only override as absent — falls back to auth_user.dj_name', async () => {
    const { showsInsert, flowsheetInsert } = setUpForStartShow('DJ Stardust', 'Alex Stardust');

    await startShow('user-1', undefined, undefined, '   ');

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues.dj_name).toBe('DJ Stardust');
    const showsValues = showsInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(showsValues.dj_name_override ?? null).toBeNull();
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
    expect(showsValues.dj_name_override ?? null).toBeNull();
    expect(showsValues.legacy_dj_name).toBeUndefined();
  });

  it('does not touch show_name / specialty_id plumbing when override is present', async () => {
    const { showsInsert } = setUpForStartShow('DJ Stardust', 'Alex Stardust');

    await startShow('user-1', 'Some Show', 7, 'Aubrey Hearst');

    const showsValues = showsInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(showsValues.show_name).toBe('Some Show');
    expect(showsValues.specialty_id).toBe(7);
    expect(showsValues.dj_name_override).toBe('Aubrey Hearst');
  });

  // BS#2846: the marker must fit flowsheet.message varchar(250). The suffix holds a
  // locale-formatted timestamp whose length varies, so the clock is pinned and the
  // name budget is derived from the same timestamp the service formats.
  describe('show_start marker length (BS#2846)', () => {
    const MARKER_PREFIX = 'Start of Show: ';
    const MESSAGE_LIMIT = 250;

    beforeEach(() => {
      // Fake only Date so the mocked promise chains are unaffected.
      jest.useFakeTimers({
        now: new Date('2026-10-16T21:50:07Z'),
        doNotFake: [
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'requestIdleCallback',
          'cancelIdleCallback',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
        ],
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const expectedSuffix = () =>
      ` joined the set at ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`;
    const nameBudget = () => MESSAGE_LIMIT - MARKER_PREFIX.length - Array.from(expectedSuffix()).length;

    const runWithOverride = async (override: string) => {
      const userSelect = createMockQueryChain();
      userSelect.limit.mockResolvedValue([{ djName: 'DJ Stardust', name: null }]);
      db.select.mockReturnValueOnce(userSelect);
      db.insert.mockReturnValueOnce(createMockQueryChain([{ id: 42 }]));
      db.insert.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-1' }]));
      db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));
      const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
      db.insert.mockReturnValueOnce(flowsheetInsert);

      await startShow('user-1', undefined, undefined, override);

      return flowsheetInsert.values.mock.calls[0]?.[0] as { message: string; dj_name: string };
    };

    // Distinct code points per position, so a wrong cut shows up in the comparison.
    const buildOverride = (base: number, length: number) =>
      Array.from({ length }, (_, i) => String.fromCodePoint(base + (i % 26))).join('');

    it.each([
      ['ASCII', 'exact fit', 0x61, 0],
      ['ASCII', 'one code point over', 0x61, 1],
      ['ASCII', 'far over the 255 cap', 0x61, 255],
      ['astral', 'exact fit', 0x1d11e, 0],
      ['astral', 'one code point over', 0x1d11e, 1],
      ['astral', 'far over the 255 cap', 0x1d11e, 255],
    ])(
      '%s override, %s: keeps the first code points that fit and the suffix intact',
      async (_script, _case, base, over) => {
        // `over` of 255 means a 255 code point override; otherwise budget + over.
        const length = over === 255 ? 255 : nameBudget() + over;
        const override = buildOverride(base, length);
        const kept = Array.from(override).slice(0, nameBudget()).join('');

        const values = await runWithOverride(override);

        expect(values.message).toBe(`${MARKER_PREFIX}${kept}${expectedSuffix()}`);
        expect(Array.from(values.message).length).toBe(MESSAGE_LIMIT);
        expect(values.dj_name).toBe(override);
      }
    );

    it('leaves a short override untouched', async () => {
      const values = await runWithOverride('Aubrey Hearst');
      expect(values.message).toMatch(/^Start of Show: Aubrey Hearst joined the set at /);
    });
  });
});
