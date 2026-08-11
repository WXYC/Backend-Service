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
 * the `@wxyc/database` mock actually interprets the drizzle predicate, so the
 * fixture `[show_start(play_order 1), track(play_order 2)]` resolves the way
 * postgres-js would. The old DESC query would resolve the track (red); the
 * entry_type-filtered query resolves the marker (green). Both lifecycle
 * handlers share one `mirrorAnnouncementEntry` helper, so the endShow describe
 * below pins the same query through its own entry_type.
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

// No `orderBy` rung: the announcement query is predicate-only since both
// call sites moved to the shared `mirrorAnnouncementEntry` helper. Leaving it
// out is deliberate — re-adding an ORDER BY in production fails here loudly
// ("orderBy is not a function") instead of being silently swallowed.
const mockDbSelect = jest.fn(() => {
  const state: { table: string | null; pred: unknown } = { table: null, pred: null };
  const builder: Record<string, unknown> = {
    from: (table: { __table?: string }) => {
      state.table = table?.__table ?? null;
      return builder;
    },
    where: (pred: unknown) => {
      state.pred = pred;
      return builder;
    },
    limit: (n: number) => {
      const out = rowsFor(state.table).filter((r) => matchPred(r, state.pred));
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
  shows: { __table: 'shows', id: 'id', legacy_show_id: 'legacy_show_id', primary_dj_id: 'primary_dj_id' },
}));

// Exactly flowsheet.mirror.ts's import surface (and/eq/isNull) — a drift
// between this list and the module's imports must fail loudly as "undefined
// is not a function", never silently no-op.
jest.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ kind: 'eq', col, val }),
  and: (...clauses: unknown[]) => ({ kind: 'and', clauses }),
  isNull: (col: unknown) => ({ kind: 'isNull', col }),
}));

jest.mock('posthog-node', () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    isFeatureEnabled: jest.fn().mockResolvedValue(true),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockCaptureException = jest.fn();
const mockCaptureMessage = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: mockCaptureException,
  captureMessage: mockCaptureMessage,
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

  it('POSTs no announcement when the tubafrenzy show-create failed (no orphan entry, no poisoned marker)', async () => {
    // mirrorCreateShow returning null means there is no parent radio show to
    // hang the entry off. Mirroring it anyway would POST an orphan
    // START_OF_SHOW *and* stamp legacy_entry_id on the marker, hiding it from
    // legacy-mirror-reconcile's `legacy_entry_id IS NULL` sweep forever.
    mockMirrorCreateShow.mockResolvedValueOnce(null);

    await runMiddleware(flowsheetMirror.startShow, showPayload);

    expect(mockMirrorCreateEntry).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
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

describe('endShow mirror announces the show_end MARKER under the co-host race (BS#1119 follow-up)', () => {
  const endedShowPayload = {
    id: SHOW_ID,
    primary_dj_id: DJ_ID,
    legacy_show_id: 172277,
    start_time: '2026-06-20T18:32:00.000Z',
    end_time: '2026-06-20T20:00:00.000Z',
  };

  // The fixture that makes this suite a real regression pin: a co-host track
  // that squeaked past the active-show check sits ABOVE the marker by
  // play_order, and comes first in row order. Both mutants therefore resolve
  // the TRACK — the pre-fix `ORDER BY play_order DESC LIMIT 1`, and a bare
  // `WHERE show_id LIMIT 1` with the entry_type predicate deleted. Only the
  // entry_type-filtered query resolves the marker.
  const coHostTrack = { id: 6000, show_id: SHOW_ID, entry_type: 'track', play_order: 6, legacy_entry_id: null };
  const endMarker = { id: 6001, show_id: SHOW_ID, entry_type: 'show_end', play_order: 5, legacy_entry_id: null };

  beforeEach(() => {
    jest.clearAllMocks();
    updateCalls.length = 0;
    userRows = [{ id: DJ_ID, dj_name: 'dj hydra' }];
    coHostTrack.legacy_entry_id = null;
    endMarker.legacy_entry_id = null;
    flowsheetRows = [coHostTrack, endMarker];
  });

  it('mirrors the show_end marker, not the higher-play_order co-host track', async () => {
    await runMiddleware(flowsheetMirror.endShow, endedShowPayload);

    expect(mockMapEntryToTubafrenzy).toHaveBeenCalledTimes(1);
    const announced = mockMapEntryToTubafrenzy.mock.calls[0][0] as typeof endMarker;
    expect(announced.entry_type).toBe('show_end');
    expect(announced.id).toBe(endMarker.id);

    // legacy_entry_id is stamped on the MARKER, not the co-host track — a
    // stamp on the track would both duplicate it in tubafrenzy (its own
    // addEntry already mirrored it) and race that mirror's own persist.
    const stamp = updateCalls.find((c) => c.setArg && 'legacy_entry_id' in c.setArg);
    expect(stamp?.pred).toMatchObject({ kind: 'eq', col: 'id', val: endMarker.id });

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('does not re-POST the show_end marker once it has already been mirrored (idempotent re-fire)', async () => {
    endMarker.legacy_entry_id = 2632180;
    flowsheetRows = [coHostTrack, endMarker];

    await runMiddleware(flowsheetMirror.endShow, endedShowPayload);

    // The isNull(legacy_entry_id) guard filters the mirrored marker out — and
    // must NOT fall through to the unmirrored co-host track instead.
    expect(mockMirrorCreateEntry).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
