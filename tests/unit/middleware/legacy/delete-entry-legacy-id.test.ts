/**
 * Tests for the legacy `deleteEntry` mirror keying on the tubafrenzy surrogate
 * key (BS#1101).
 *
 * The prior implementation resolved the target row positionally:
 *
 *   SET @RS_ID := (SELECT IFNULL(MAX(ID), 0) FROM FLOWSHEET_RADIO_SHOW_PROD);
 *   DELETE FROM FLOWSHEET_ENTRY_PROD
 *     WHERE RADIO_SHOW_ID = @RS_ID AND SEQUENCE_WITHIN_SHOW = <play_order> LIMIT 1;
 *
 * Both predicates are wrong:
 *
 *  - `MAX(ID)` is the newest tubafrenzy show, not the deleted entry's show, so
 *    correcting an older show deletes from the wrong show (cross-show).
 *  - Even for the right show, tubafrenzy's `SEQUENCE_WITHIN_SHOW` (assigned at
 *    insert as `MAX(SEQUENCE_WITHIN_SHOW)+1`) and BS `play_order` are assigned
 *    independently and diverge — BS `play_order` counts lifecycle markers that
 *    tubafrenzy never materializes as entry rows — so the positional predicate
 *    misses even in the happy path (within-show miss).
 *
 * The fix keys the DELETE on `legacy_entry_id`, the ID tubafrenzy assigned and
 * BS persisted on the row at insert. These tests drive the real middleware and
 * assert on the SQL it enqueues to the mirror command queue — the SSH/SQL path
 * itself is not observable in CI, so the generated statement is the contract.
 */

// --- Mocks (hoisted per-module) ---

const mockEnqueue = jest.fn();
jest.mock('../../../../apps/backend/middleware/legacy/commandqueue.mirror', () => ({
  MirrorCommandQueue: {
    instance: jest.fn(() => ({ enqueue: mockEnqueue })),
  },
}));

// The delete path reads no HTTP mirror helpers, but flowsheet.mirror.ts imports
// the module at load; stub it so the import graph resolves without a real client.
jest.mock('../../../../apps/backend/middleware/legacy/http.mirror', () => ({
  mirrorCreateEntry: jest.fn(),
  mirrorCreateShow: jest.fn(),
  mirrorSignoffShow: jest.fn(),
  mirrorUpdateEntry: jest.fn(),
  cacheEntryId: jest.fn(),
  cacheShowId: jest.fn(),
  getCachedEntryId: jest.fn(),
  getCachedShowId: jest.fn(),
  clearEntryIdMap: jest.fn(),
  clearShowIdMap: jest.fn(),
  mapEntryToTubafrenzy: jest.fn(),
  mapShowToTubafrenzy: jest.fn(),
  mapUpdateToTubafrenzy: jest.fn(),
}));

jest.mock('@wxyc/database', () => ({
  db: {},
  user: {},
  flowsheet: { id: 'id', legacy_entry_id: 'legacy_entry_id', show_id: 'show_id' },
  shows: { id: 'id', legacy_show_id: 'legacy_show_id' },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((...args: unknown[]) => args),
  desc: jest.fn(),
  asc: jest.fn(),
}));

jest.mock('posthog-node', () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    isFeatureEnabled: jest.fn().mockResolvedValue(true),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
}));

jest.mock('../../../../apps/backend/middleware/legacy/rotation-match.mirror', () => ({
  isActiveRotationMatch: jest.fn().mockResolvedValue(false),
}));

import { runMiddleware } from './http-mirror-harness';

// Import the middleware AFTER all mocks are set up
import { flowsheetMirror } from '../../../../apps/backend/middleware/legacy/flowsheet.mirror';
import { createBackendMirrorMiddleware } from '../../../../apps/backend/middleware/legacy/mirror.middleware';

// The single transaction body the mirror enqueued this run, or undefined if it
// never enqueued (no-op).
function enqueuedSql(): string | undefined {
  if (mockEnqueue.mock.calls.length === 0) return undefined;
  const [statements] = mockEnqueue.mock.calls[mockEnqueue.mock.calls.length - 1];
  return (statements as string[]).join('\n');
}

const baseRemovedEntry = {
  id: 42,
  show_id: 100,
  album_id: null,
  rotation_id: null,
  legacy_entry_id: 555 as number | null,
  entry_type: 'track',
  track_title: 'la paradoja',
  album_title: 'DOGA',
  artist_name: 'Juana Molina',
  record_label: 'Sonamos',
  play_order: 3,
  request_flag: false,
  segue: false,
  message: null as string | null,
  add_time: new Date('2024-02-01T12:00:00Z').toISOString(),
};

describe('deleteEntry mirror keys on legacy_entry_id (BS#1101)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes by the tubafrenzy surrogate ID, not the positional predicate', async () => {
    await runMiddleware(flowsheetMirror.deleteEntry, { ...baseRemovedEntry, legacy_entry_id: 555 });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const sql = enqueuedSql();
    expect(sql).toContain('DELETE FROM FLOWSHEET_ENTRY_PROD');
    expect(sql).toContain('WHERE ID = 555');
  });

  it('does not resolve the show via MAX(ID) or match by SEQUENCE_WITHIN_SHOW (cross-show + within-show fix)', async () => {
    // play_order = 3 but the tubafrenzy row's SEQUENCE_WITHIN_SHOW would be 1;
    // keying on legacy_entry_id must ignore play_order entirely.
    await runMiddleware(flowsheetMirror.deleteEntry, { ...baseRemovedEntry, play_order: 3, legacy_entry_id: 555 });
    const sql = enqueuedSql();
    expect(sql).not.toContain('MAX(ID)');
    expect(sql).not.toContain('RADIO_SHOW_ID');
    expect(sql).not.toContain('SEQUENCE_WITHIN_SHOW');
    // The diverging play_order value must not leak into the statement.
    expect(sql).not.toContain('= 3');
  });

  it('no-ops (enqueues nothing) when legacy_entry_id is null — no safe target to guess', async () => {
    await runMiddleware(flowsheetMirror.deleteEntry, { ...baseRemovedEntry, legacy_entry_id: null });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('coerces legacy_entry_id to a safe integer literal', async () => {
    await runMiddleware(flowsheetMirror.deleteEntry, { ...baseRemovedEntry, legacy_entry_id: 171792 });
    const sql = enqueuedSql();
    expect(sql).toContain('WHERE ID = 171792');
  });
});

// Direct coverage for the factory guard the null-legacy_entry_id case relies on:
// a backend mirror handler that returns no statements must not enqueue an empty
// `START TRANSACTION; COMMIT;` for the SSH executor. deleteEntry exercises this
// transitively; this asserts the guard independent of deleteEntry's logic
// (changeOrder's `return []` hard guard leans on the same behavior).
describe('createBackendMirrorMiddleware skips the enqueue on an empty statement list', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not enqueue when the command builder returns []', async () => {
    const emptyMirror = createBackendMirrorMiddleware<typeof baseRemovedEntry>(() => Promise.resolve<string[]>([]));
    await runMiddleware(emptyMirror, baseRemovedEntry);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('enqueues when the command builder returns statements', async () => {
    const nonEmptyMirror = createBackendMirrorMiddleware<typeof baseRemovedEntry>(() => Promise.resolve(['SELECT 1;']));
    await runMiddleware(nonEmptyMirror, baseRemovedEntry);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(enqueuedSql()).toContain('SELECT 1;');
  });
});
