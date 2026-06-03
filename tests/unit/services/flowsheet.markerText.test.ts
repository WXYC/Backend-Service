/**
 * Marker text regression tests for the four lifecycle entry types after the
 * 2026-06-02 Aubrey Hearst on-air incident (WXYC/Backend-Service#1286, parent
 * epic #1288).
 *
 * Locked decisions exercised here:
 *   1. No marker template carries a literal "DJ " prefix — DJs read
 *      "DJ Aubrey Hearst" as if "DJ" were part of their name.
 *   2. show_start / show_end: when the DJ name is unresolvable, the marker
 *      still writes a row, but the message degrades to a bare
 *      "Start of show: ${time}" / "End of show: ${time}". The show *did*
 *      start; the row must exist for downstream consumers.
 *   3. dj_join / dj_leave: when the DJ name is unresolvable, suppress the
 *      flowsheet row entirely and log a Sentry warning with dj_id + show_id
 *      so the degraded state is debuggable.
 *
 * "Unresolvable" follows the resolveDjDisplayName contract (both inputs
 * blank, or djName === "Anonymous" with no fallback name).
 */
import { jest } from '@jest/globals';
import { db, createMockQueryChain } from '../../mocks/database.mock';

jest.mock('@sentry/node', () => ({
  captureMessage: jest.fn(),
}));

import * as Sentry from '@sentry/node';
import { startShow, endShow, addDJToShow, leaveShow } from '../../../apps/backend/services/flowsheet.service';

const makeAwaitablePlayOrderChain = (max: number) => {
  const chain = createMockQueryChain();
  (chain as unknown as { then: (resolve: (v: unknown) => void) => void }).then = (resolve) => resolve([{ max }]);
  return chain;
};

const setUpUserAndPlayOrderForStartShow = (djName: string | null, name: string | null) => {
  const userSelect = createMockQueryChain();
  userSelect.limit.mockResolvedValue([{ djName, name }]);
  db.select.mockReturnValueOnce(userSelect);

  db.insert.mockReturnValueOnce(createMockQueryChain([{ id: 42 }]));
  db.insert.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-1' }]));
  db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));
  const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
  db.insert.mockReturnValueOnce(flowsheetInsert);
  return flowsheetInsert;
};

const setUpForEndShow = (djName: string | null, name: string | null) => {
  // remaining_djs select (empty so the inner loop is a no-op)
  const remainingDjsSelect = createMockQueryChain();
  remainingDjsSelect.where.mockResolvedValue([]);
  db.select.mockReturnValueOnce(remainingDjsSelect);

  // user lookup
  const userSelect = createMockQueryChain();
  userSelect.limit.mockResolvedValue([{ djName, name }]);
  db.select.mockReturnValueOnce(userSelect);

  // nextPlayOrder
  db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));

  // flowsheet insert
  const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
  db.insert.mockReturnValueOnce(flowsheetInsert);

  // shows update
  db.update.mockReturnValueOnce(createMockQueryChain([{}]));

  // getLatestShow
  const latestShowSelect = createMockQueryChain();
  latestShowSelect.limit.mockResolvedValue([{ id: 42, end_time: new Date() }]);
  db.select.mockReturnValueOnce(latestShowSelect);

  return flowsheetInsert;
};

const setUpForAddDJ = (djName: string | null, name: string | null) => {
  // initial show_djs select — no existing membership
  const showDjsSelect = createMockQueryChain();
  showDjsSelect.limit.mockResolvedValue([]);
  db.select.mockReturnValueOnce(showDjsSelect);

  // show_djs insert
  db.insert.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-2', active: true }]));

  // user lookup inside createJoinNotification
  const userSelect = createMockQueryChain();
  userSelect.limit.mockResolvedValue([{ djName, name }]);
  db.select.mockReturnValueOnce(userSelect);

  // nextPlayOrder
  db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));

  // flowsheet insert
  const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
  db.insert.mockReturnValueOnce(flowsheetInsert);

  return flowsheetInsert;
};

const setUpForLeaveShow = (djName: string | null, name: string | null) => {
  // show_djs update returning the updated row
  db.update.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-2', active: false }]));

  // user lookup
  const userSelect = createMockQueryChain();
  userSelect.limit.mockResolvedValue([{ djName, name }]);
  db.select.mockReturnValueOnce(userSelect);

  // nextPlayOrder
  db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));

  // flowsheet insert
  const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
  db.insert.mockReturnValueOnce(flowsheetInsert);

  return flowsheetInsert;
};

describe('startShow marker text', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Sentry.captureMessage as jest.Mock).mockClear();
  });

  it('emits "Start of Show: <name> joined the set at ..." with no "DJ " prefix when djName resolves', async () => {
    const flowsheetInsert = setUpUserAndPlayOrderForStartShow('DJ Stardust', 'Alex Stardust');
    await startShow('user-1');

    const values = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.entry_type).toBe('show_start');
    expect(values.dj_name).toBe('DJ Stardust');
    expect(values.message).toMatch(/^Start of Show: DJ Stardust joined the set at /);
    // Defense in depth — guard against any regression that re-introduces the prefix.
    expect(values.message).not.toMatch(/Start of Show: DJ DJ /);
  });

  it('strips literal "Anonymous" djName and falls back to user.name for the marker (Aubrey Hearst incident regression)', async () => {
    const flowsheetInsert = setUpUserAndPlayOrderForStartShow('Anonymous', 'Aubrey Hearst');
    await startShow('user-1');

    const values = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.dj_name).toBe('Aubrey Hearst');
    expect(values.message).toMatch(/^Start of Show: Aubrey Hearst joined the set at /);
    expect(values.message).not.toMatch(/Anonymous/);
  });

  it('case- and whitespace-insensitive "  anonymous  " is still treated as Anonymous', async () => {
    const flowsheetInsert = setUpUserAndPlayOrderForStartShow('  anonymous  ', 'Aubrey Hearst');
    await startShow('user-1');

    const values = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.dj_name).toBe('Aubrey Hearst');
    expect(values.message).toMatch(/^Start of Show: Aubrey Hearst joined the set at /);
    expect((values.message as string | null)?.toLowerCase() ?? '').not.toContain('anonymous');
  });

  it('degrades to "Start of show: <time>" (lowercase "show", no DJ name) when name is unresolvable', async () => {
    const flowsheetInsert = setUpUserAndPlayOrderForStartShow(null, null);
    await startShow('user-1');

    const values = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.dj_name).toBeNull();
    expect(values.message).toMatch(/^Start of show: /);
    expect(values.message).not.toMatch(/joined the set/);
    expect(values.message).not.toMatch(/\bDJ\b/);
  });

  it('also degrades when djName is "Anonymous" and name is null', async () => {
    const flowsheetInsert = setUpUserAndPlayOrderForStartShow('Anonymous', null);
    await startShow('user-1');

    const values = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.dj_name).toBeNull();
    expect(values.message).toMatch(/^Start of show: /);
    expect(values.message).not.toMatch(/Anonymous/);
  });
});

describe('endShow marker text', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Sentry.captureMessage as jest.Mock).mockClear();
  });

  it('emits "End of Show: <name> left the set at ..." with no "DJ " prefix when name resolves', async () => {
    const flowsheetInsert = setUpForEndShow('DJ Night Owl', 'Riley Owens');
    await endShow({ id: 42, primary_dj_id: 'user-1' } as unknown as Parameters<typeof endShow>[0]);

    const values = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.entry_type).toBe('show_end');
    expect(values.dj_name).toBe('DJ Night Owl');
    expect(values.message).toMatch(/^End of Show: DJ Night Owl left the set at /);
    expect(values.message).not.toMatch(/End of Show: DJ DJ /);
  });

  it('strips literal "Anonymous" djName and falls back to user.name for the marker', async () => {
    const flowsheetInsert = setUpForEndShow('Anonymous', 'Aubrey Hearst');
    await endShow({ id: 42, primary_dj_id: 'user-1' } as unknown as Parameters<typeof endShow>[0]);

    const values = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.dj_name).toBe('Aubrey Hearst');
    expect(values.message).toMatch(/^End of Show: Aubrey Hearst left the set at /);
  });

  it('degrades to "End of show: <time>" when both djName and name are null', async () => {
    const flowsheetInsert = setUpForEndShow(null, null);
    await endShow({ id: 42, primary_dj_id: 'user-1' } as unknown as Parameters<typeof endShow>[0]);

    const values = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.dj_name).toBeNull();
    expect(values.message).toMatch(/^End of show: /);
    expect(values.message).not.toMatch(/left the set/);
    expect(values.message).not.toMatch(/\bDJ\b/);
  });
});

describe('createJoinNotification (via addDJToShow) marker text', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Sentry.captureMessage as jest.Mock).mockClear();
  });

  it('emits "<name> joined the set!" with no "DJ " prefix when name resolves', async () => {
    const flowsheetInsert = setUpForAddDJ('DJ Bluejay', 'Sam Blue');
    await addDJToShow('user-2', { id: 42 } as unknown as Parameters<typeof addDJToShow>[1]);

    const values = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.dj_name).toBe('DJ Bluejay');
    expect(values.message).toBe('DJ Bluejay joined the set!');
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('strips literal "Anonymous" djName and falls back to user.name', async () => {
    const flowsheetInsert = setUpForAddDJ('Anonymous', 'Aubrey Hearst');
    await addDJToShow('user-2', { id: 42 } as unknown as Parameters<typeof addDJToShow>[1]);

    const values = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.dj_name).toBe('Aubrey Hearst');
    expect(values.message).toBe('Aubrey Hearst joined the set!');
  });

  it('suppresses the marker AND logs to Sentry when name is unresolvable', async () => {
    // setUpForAddDJ still queues the user lookup; the suppression path means
    // the flowsheet insert is never reached. Skip queuing the flowsheet
    // insert mock so an accidental call would surface as a test failure.
    const showDjsSelect = createMockQueryChain();
    showDjsSelect.limit.mockResolvedValue([]);
    db.select.mockReturnValueOnce(showDjsSelect);
    db.insert.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-2', active: true }]));
    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: null, name: null }]);
    db.select.mockReturnValueOnce(userSelect);

    await addDJToShow('user-2', { id: 42 } as unknown as Parameters<typeof addDJToShow>[1]);

    // Only the show_djs insert should have happened — no flowsheet insert.
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/dj_join.*unresolvable/i),
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ dj_id: 'user-2', show_id: 42 }),
      })
    );
  });

  it('also suppresses + logs when djName is "Anonymous" and name is null', async () => {
    const showDjsSelect = createMockQueryChain();
    showDjsSelect.limit.mockResolvedValue([]);
    db.select.mockReturnValueOnce(showDjsSelect);
    db.insert.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-2', active: true }]));
    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: 'Anonymous', name: null }]);
    db.select.mockReturnValueOnce(userSelect);

    await addDJToShow('user-2', { id: 42 } as unknown as Parameters<typeof addDJToShow>[1]);

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });
});

describe('createLeaveNotification (via leaveShow) marker text', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Sentry.captureMessage as jest.Mock).mockClear();
  });

  it('emits "<name> left the set!" with no "DJ " prefix when name resolves', async () => {
    const flowsheetInsert = setUpForLeaveShow('DJ Shadow', 'Josh Davis');
    await leaveShow('user-2', { id: 42 } as unknown as Parameters<typeof leaveShow>[1]);

    const values = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.dj_name).toBe('DJ Shadow');
    expect(values.message).toBe('DJ Shadow left the set!');
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('strips literal "Anonymous" djName and falls back to user.name', async () => {
    const flowsheetInsert = setUpForLeaveShow('Anonymous', 'Aubrey Hearst');
    await leaveShow('user-2', { id: 42 } as unknown as Parameters<typeof leaveShow>[1]);

    const values = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(values.dj_name).toBe('Aubrey Hearst');
    expect(values.message).toBe('Aubrey Hearst left the set!');
  });

  it('suppresses the marker AND logs to Sentry when name is unresolvable', async () => {
    db.update.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-2', active: false }]));
    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: null, name: null }]);
    db.select.mockReturnValueOnce(userSelect);

    await leaveShow('user-2', { id: 42 } as unknown as Parameters<typeof leaveShow>[1]);

    // Only the show_djs update should fire — no flowsheet insert.
    expect(db.insert).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/dj_leave.*unresolvable/i),
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({ dj_id: 'user-2', show_id: 42 }),
      })
    );
  });
});
