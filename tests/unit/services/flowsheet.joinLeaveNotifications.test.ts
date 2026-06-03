import { jest } from '@jest/globals';
import { db, createMockQueryChain } from '../../mocks/database.mock';

jest.mock('@sentry/node', () => ({
  captureMessage: jest.fn(),
}));

import { addDJToShow, leaveShow } from '../../../apps/backend/services/flowsheet.service';

const makeAwaitablePlayOrderChain = (max: number) => {
  const chain = createMockQueryChain();
  (chain as unknown as { then: (resolve: (v: unknown) => void) => void }).then = (resolve) => resolve([{ max }]);
  return chain;
};

// jest.clearAllMocks() does not drain mockReturnValueOnce queues. If a test
// queues a chain that the code never consumes (e.g. the suppression-path
// tests below queue no flowsheet insert), the queued chain would leak into
// the next test's call. Reset the implementations explicitly so each test
// starts from a clean queue.
const resetMockDbQueues = () => {
  db.select.mockReset();
  db.insert.mockReset();
  db.update.mockReset();
};

describe('createJoinNotification (via addDJToShow)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockDbQueues();
  });

  it('persists dj_name (from user.djName) on the dj_join flowsheet row', async () => {
    // initial show_djs select — no existing membership
    const showDjsSelect = createMockQueryChain();
    showDjsSelect.limit.mockResolvedValue([]);
    db.select.mockReturnValueOnce(showDjsSelect);

    // show_djs insert (returning the new membership)
    db.insert.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-2', active: true }]));

    // user lookup inside createJoinNotification
    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: 'DJ Bluejay', name: 'Sam Blue' }]);
    db.select.mockReturnValueOnce(userSelect);

    // nextPlayOrder
    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(3));

    // flowsheet insert — inspection target
    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);

    await addDJToShow('user-2', { id: 42 } as unknown as Parameters<typeof addDJToShow>[1]);

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues).toEqual(
      expect.objectContaining({
        entry_type: 'dj_join',
        dj_name: 'DJ Bluejay',
      })
    );
  });

  it('falls back to user.name when djName is null', async () => {
    const showDjsSelect = createMockQueryChain();
    showDjsSelect.limit.mockResolvedValue([]);
    db.select.mockReturnValueOnce(showDjsSelect);

    db.insert.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-2', active: true }]));

    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: null, name: 'Sam Blue' }]);
    db.select.mockReturnValueOnce(userSelect);

    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));

    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);

    await addDJToShow('user-2', { id: 42 } as unknown as Parameters<typeof addDJToShow>[1]);

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues.dj_name).toBe('Sam Blue');
  });

  it('suppresses the flowsheet row when the user has neither djName nor name (#1286)', async () => {
    // Post-#1286: a nameless mid-show join is a degraded state — better
    // logged than written to the public on-air playlist. The flowsheet
    // insert is suppressed; only the show_djs membership insert fires.
    // See flowsheet.markerText.test.ts for the Sentry-message assertion.
    const showDjsSelect = createMockQueryChain();
    showDjsSelect.limit.mockResolvedValue([]);
    db.select.mockReturnValueOnce(showDjsSelect);

    db.insert.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-2', active: true }]));

    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: null, name: null }]);
    db.select.mockReturnValueOnce(userSelect);

    await addDJToShow('user-2', { id: 42 } as unknown as Parameters<typeof addDJToShow>[1]);

    // Exactly one db.insert call — the show_djs membership row. No flowsheet row.
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});

describe('createLeaveNotification (via leaveShow service)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockDbQueues();
  });

  it('persists dj_name (from user.djName) on the dj_leave flowsheet row', async () => {
    // show_djs update returning the updated row
    db.update.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-2', active: false }]));

    // user lookup
    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: 'DJ Shadow', name: 'Josh Davis' }]);
    db.select.mockReturnValueOnce(userSelect);

    // nextPlayOrder
    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(5));

    // flowsheet insert
    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);

    await leaveShow('user-2', { id: 42 } as unknown as Parameters<typeof leaveShow>[1]);

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues).toEqual(
      expect.objectContaining({
        entry_type: 'dj_leave',
        dj_name: 'DJ Shadow',
      })
    );
  });

  it('falls back to user.name when djName is null', async () => {
    db.update.mockReturnValueOnce(createMockQueryChain([{ show_id: 42, dj_id: 'user-2', active: false }]));

    const userSelect = createMockQueryChain();
    userSelect.limit.mockResolvedValue([{ djName: null, name: 'Josh Davis' }]);
    db.select.mockReturnValueOnce(userSelect);

    db.select.mockReturnValueOnce(makeAwaitablePlayOrderChain(0));

    const flowsheetInsert = createMockQueryChain([{ id: 999 }]);
    db.insert.mockReturnValueOnce(flowsheetInsert);

    await leaveShow('user-2', { id: 42 } as unknown as Parameters<typeof leaveShow>[1]);

    const flowsheetValues = flowsheetInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(flowsheetValues.dj_name).toBe('Josh Davis');
  });
});
