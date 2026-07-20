/**
 * BS#1705 — the /flowsheet/join mirror (startShow) must announce the
 * `show_start` MARKER, not the newest flowsheet row by play_order.
 *
 * In normal operation the marker is the only (and newest) entry when the
 * mirror fires, so the old `ORDER BY play_order DESC LIMIT 1` happened to
 * return it. But if the announcement mirror ever runs after a track already
 * exists for the show, the DESC query returns the TRACK — the actual
 * `show_start` marker is never mirrored, and the tubafrenzy show is created
 * with no START_OF_SHOW (type 9) entry (prod: BS shows.id 1949437 /
 * tubafrenzy 172277).
 *
 * These tests drive the REAL middleware through a faithful mini query engine:
 * the `@wxyc/database` mock actually interprets the drizzle predicate/order so
 * the fixture `[show_start(play_order 1), track(play_order 2)]` resolves the
 * way postgres-js would. The old DESC query would resolve the track (red); the
 * entry_type-filtered query resolves the marker (green).
 *
 * Harness follows endshow-shape-guard.test.ts: real middleware, mocks only at
 * process boundaries (tubafrenzy HTTP client, database, PostHog, Sentry).
 */

// --- Faithful mini query engine (module scope; not referenced by jest.mock factories) ---

function matchPred(row: Record<string, unknown>, pred: any): boolean {
  if (!pred) return true;
  switch (pred.kind) {
    case 'and':
      return pred.clauses.every((c: unknown) => matchPred(row, c));
    case 'eq':
      return row[pred.col] === pred.val;
    case 'isNull':
      return row[pred.col] === null || row[pred.col] === undefined;
    default:
      return true;
  }
}

function applyOrder(rows: Record<string, unknown>[], order: any): Record<string, unknown>[] {
  if (order?.kind === 'desc') {
    return [...rows].sort((a, b) => Number(b[order.col] ?? 0) - Number(a[order.col] ?? 0));
  }
  if (order?.kind === 'asc') {
    return [...rows].sort((a, b) => Number(a[order.col] ?? 0) - Number(b[order.col] ?? 0));
  }
  return rows;
}

// Per-test fixtures, keyed by table.
let userRows: Record<string, unknown>[] = [];
let flowsheetRows: Record<string, unknown>[] = [];

function rowsFor(table: string | null): Record<string, unknown>[] {
  if (table === 'user') return userRows;
  if (table === 'flowsheet') return flowsheetRows;
  return [];
}

// --- Mocks ---

const mockMirrorCreateShow = jest.fn().mockResolvedValue(172277);
const mockMirrorCreateEntry = jest.fn().mockResolvedValue(999);
const mockMapEntryToTubafrenzy = jest.fn((row: unknown) => ({ __row: row }));
const mockCacheEntryId = jest.fn();

jest.mock('../../../../apps/backend/middleware/legacy/http.mirror', () => ({
  mirrorCreateEntry: mockMirrorCreateEntry,
  mirrorCreateShow: mockMirrorCreateShow,
  mirrorSignoffShow: jest.fn(),
  mirrorUpdateEntry: jest.fn(),
  cacheEntryId: mockCacheEntryId,
  cacheShowId: jest.fn(),
  getCachedEntryId: jest.fn(),
  getCachedShowId: jest.fn().mockReturnValue(undefined),
  clearEntryIdMap: jest.fn(),
  clearShowIdMap: jest.fn(),
  mapEntryToTubafrenzy: mockMapEntryToTubafrenzy,
  mapShowToTubafrenzy: jest.fn().mockReturnValue({}),
  mapUpdateToTubafrenzy: jest.fn(),
}));

const mockDbSelect = jest.fn(() => {
  const state: { table: string | null; pred: unknown; order: unknown } = { table: null, pred: null, order: null };
  const builder: Record<string, unknown> = {
    from: (table: { __table?: string }) => {
      state.table = table?.__table ?? null;
      return builder;
    },
    where: (pred: unknown) => {
      state.pred = pred;
      return builder;
    },
    orderBy: (order: unknown) => {
      state.order = order;
      return builder;
    },
    limit: (n: number) => {
      let out = rowsFor(state.table).filter((r) => matchPred(r, state.pred));
      if (state.order) out = applyOrder(out, state.order);
      return Promise.resolve(out.slice(0, n));
    },
  };
  return builder;
});

// Records every db.update(...).set(...).where(...) so a test can assert which
// row got legacy_entry_id stamped (the marker, not the track).
const updateCalls: { table: string | null; setArg: any; pred: any }[] = [];
const mockDbUpdate = jest.fn((table: { __table?: string }) => ({
  set: (setArg: unknown) => ({
    where: (pred: unknown) => {
      updateCalls.push({ table: table?.__table ?? null, setArg, pred });
      return Promise.resolve(undefined);
    },
  }),
}));

jest.mock('@wxyc/database', () => ({
  db: { select: mockDbSelect, update: mockDbUpdate },
  user: { __table: 'user', id: 'id' },
  flowsheet: {
    __table: 'flowsheet',
    id: 'id',
    show_id: 'show_id',
    entry_type: 'entry_type',
    play_order: 'play_order',
    legacy_entry_id: 'legacy_entry_id',
  },
  shows: { __table: 'shows', id: 'id', legacy_show_id: 'legacy_show_id' },
}));

jest.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ kind: 'eq', col, val }),
  and: (...clauses: unknown[]) => ({ kind: 'and', clauses }),
  isNull: (col: unknown) => ({ kind: 'isNull', col }),
  desc: (col: unknown) => ({ kind: 'desc', col }),
  asc: (col: unknown) => ({ kind: 'asc', col }),
}));

jest.mock('posthog-node', () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    isFeatureEnabled: jest.fn().mockResolvedValue(true),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: mockCaptureException,
}));

jest.mock('../../../../apps/backend/middleware/legacy/rotation-match.mirror', () => ({
  isActiveRotationMatch: jest.fn().mockResolvedValue(false),
}));

import { runMiddleware } from './http-mirror-harness';

// Import the middleware AFTER all mocks are set up
import { flowsheetMirror } from '../../../../apps/backend/middleware/legacy/flowsheet.mirror';

const SHOW_ID = 1949437;
const DJ_ID = 'dj-hydra-user-id';

// The show payload the joinShow controller returns (res.json(show_session)).
const showPayload = {
  id: SHOW_ID,
  primary_dj_id: DJ_ID,
  start_time: '2026-06-20T18:32:00.000Z',
  end_time: null,
};

// Prod-shaped fixture: the show_start marker has the LOWEST play_order, a
// later track has a higher one. The old DESC-by-play_order query returns the
// track; the fix returns the marker.
const marker = {
  id: 5271226,
  show_id: SHOW_ID,
  entry_type: 'show_start',
  play_order: 1,
  legacy_entry_id: null as number | null,
};
const track = {
  id: 5271300,
  show_id: SHOW_ID,
  entry_type: 'track',
  play_order: 2,
  legacy_entry_id: null as number | null,
};

describe('startShow mirror announces the show_start marker (BS#1705)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateCalls.length = 0;
    userRows = [{ id: DJ_ID, dj_name: 'dj hydra' }];
    // Reset marker/track to their pristine (un-mirrored) state each test.
    marker.legacy_entry_id = null;
    track.legacy_entry_id = null;
    flowsheetRows = [marker, track];
  });

  it('mirrors the show_start MARKER, not the newest track, when a track already exists', async () => {
    await runMiddleware(flowsheetMirror.startShow, showPayload);

    // The announcement that was mapped + POSTed is the marker, not the track.
    expect(mockMirrorCreateEntry).toHaveBeenCalledTimes(1);
    expect(mockMapEntryToTubafrenzy).toHaveBeenCalledTimes(1);
    const announced = mockMapEntryToTubafrenzy.mock.calls[0][0] as typeof marker;
    expect(announced.entry_type).toBe('show_start');
    expect(announced.id).toBe(marker.id);

    // legacy_entry_id is stamped on the MARKER row, not the track.
    const stamp = updateCalls.find((c) => c.setArg && 'legacy_entry_id' in c.setArg);
    expect(stamp).toBeDefined();
    expect(stamp?.pred).toMatchObject({ kind: 'eq', col: 'id', val: marker.id });

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('does not re-POST the marker once it has already been mirrored (idempotent re-fire)', async () => {
    // Simulate a second startShow-mirror run after the marker was mirrored.
    marker.legacy_entry_id = 2632174;
    flowsheetRows = [marker, track];

    await runMiddleware(flowsheetMirror.startShow, showPayload);

    // No announcement entry is re-POSTed (the isNull(legacy_entry_id) guard
    // filters the already-mirrored marker out — no duplicate type-9 entry).
    expect(mockMirrorCreateEntry).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});

describe('endShow mirror still announces the newest row — the show_end marker (BS#1705 regression)', () => {
  const endedShowPayload = {
    id: SHOW_ID,
    primary_dj_id: DJ_ID,
    legacy_show_id: 172277,
    start_time: '2026-06-20T18:32:00.000Z',
    end_time: '2026-06-20T20:00:00.000Z',
  };

  // show_end is genuinely the newest row (highest play_order): endShow keeps
  // the DESC-by-play_order query and must still resolve it.
  const endTrack = { id: 6000, show_id: SHOW_ID, entry_type: 'track', play_order: 4, legacy_entry_id: null };
  const endMarker = { id: 6001, show_id: SHOW_ID, entry_type: 'show_end', play_order: 5, legacy_entry_id: null };

  beforeEach(() => {
    jest.clearAllMocks();
    updateCalls.length = 0;
    userRows = [{ id: DJ_ID, dj_name: 'dj hydra' }];
    flowsheetRows = [endTrack, endMarker];
  });

  it('mirrors the show_end marker as the announcement', async () => {
    await runMiddleware(flowsheetMirror.endShow, endedShowPayload);

    expect(mockMapEntryToTubafrenzy).toHaveBeenCalledTimes(1);
    const announced = mockMapEntryToTubafrenzy.mock.calls[0][0] as typeof endMarker;
    expect(announced.entry_type).toBe('show_end');
    expect(announced.id).toBe(endMarker.id);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
