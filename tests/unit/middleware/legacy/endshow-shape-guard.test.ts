/**
 * BS#1119 — POST /flowsheet/end mirror runs endShow on leaveShow responses.
 *
 * The /flowsheet/end route registers flowsheetMirror.endShow unconditionally,
 * but the controller returns a Show only on the primary-DJ branch; a guest-DJ
 * leave (or the Auto-DJ orchestrator's restart recovery) returns a ShowDJ
 * (show_id, dj_id, active — no id, end_time, or legacy_show_id). The mirror
 * must not execute any endShow logic (signoff or the show_end announcement
 * re-query) on a ShowDJ payload.
 *
 * Harness follows mirror.loop-prevention.test.ts: real middleware, mocks only
 * at process boundaries (tubafrenzy HTTP client, database, PostHog, Sentry).
 */

// --- Mocks ---

const mockMirrorSignoffShow = jest.fn().mockResolvedValue(undefined);
const mockMirrorCreateEntry = jest.fn().mockResolvedValue(null);
const mockGetCachedShowId = jest.fn().mockReturnValue(undefined);
const mockMapEntryToTubafrenzy = jest.fn().mockReturnValue({ artistName: 'test' });

jest.mock('../../../../apps/backend/middleware/legacy/http.mirror', () => ({
  mirrorCreateEntry: mockMirrorCreateEntry,
  mirrorCreateShow: jest.fn(),
  mirrorSignoffShow: mockMirrorSignoffShow,
  mirrorUpdateEntry: jest.fn(),
  cacheEntryId: jest.fn(),
  cacheShowId: jest.fn(),
  getCachedEntryId: jest.fn(),
  getCachedShowId: mockGetCachedShowId,
  clearEntryIdMap: jest.fn(),
  clearShowIdMap: jest.fn(),
  mapEntryToTubafrenzy: mockMapEntryToTubafrenzy,
  mapShowToTubafrenzy: jest.fn(),
  mapUpdateToTubafrenzy: jest.fn(),
}));

const mockDbUpdate = jest.fn().mockReturnValue({
  set: jest.fn().mockReturnValue({
    where: jest.fn().mockResolvedValue(undefined),
  }),
});

// Configurable per-test: default resolves to [] (no announcement entry found)
let mockSelectLimitResult: unknown[] = [];

const mockDbSelect = jest.fn().mockReturnValue({
  from: jest.fn().mockReturnValue({
    where: jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockImplementation(() => Promise.resolve(mockSelectLimitResult)),
      }),
      limit: jest.fn().mockImplementation(() => Promise.resolve(mockSelectLimitResult)),
    }),
  }),
});

jest.mock('@wxyc/database', () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
  },
  user: {},
  flowsheet: { id: 'id', legacy_entry_id: 'legacy_entry_id', show_id: 'show_id' },
  shows: { id: 'id', legacy_show_id: 'legacy_show_id' },
}));

jest.mock('drizzle-orm', () => ({
  // Faithfully simulate postgres-js rejecting an `undefined` bind. The BS#1119
  // prod symptom is the show_end announcement re-query binding
  // `eq(flowsheet.show_id, undefined)` — a ShowDJ has no `id` — which throws in
  // the driver and lands in Sentry once per guest leave. Making eq() throw on an
  // undefined operand lets the ShowDJ test pin that exact symptom (the mirror
  // catching into Sentry) rather than only the proxy "db.select was reached".
  eq: jest.fn((column: unknown, value: unknown) => {
    if (value === undefined) {
      throw new Error('cannot bind undefined to a query parameter (simulated postgres-js undefined bind)');
    }
    return [column, value];
  }),
  desc: jest.fn(),
  asc: jest.fn(),
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

const mockIsActiveRotationMatch = jest.fn().mockResolvedValue(false);
jest.mock('../../../../apps/backend/middleware/legacy/rotation-match.mirror', () => ({
  isActiveRotationMatch: mockIsActiveRotationMatch,
}));

import { runMiddleware } from './http-mirror-harness';

// Import the middleware AFTER all mocks are set up
import { flowsheetMirror } from '../../../../apps/backend/middleware/legacy/flowsheet.mirror';

describe('endShow mirror payload shape guard (BS#1119)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedShowId.mockReturnValue(undefined);
    mockSelectLimitResult = [];
  });

  // What flowsheet_service.leaveShow returns for a guest-DJ leave: the
  // show_djs row — (show_id, dj_id, active) with no id / end_time / legacy_show_id.
  const showDJPayload = {
    show_id: 100,
    dj_id: 'guest-dj-user-id',
    active: false,
  };

  it('executes no endShow logic when a guest-DJ leave returns a ShowDJ payload', async () => {
    await runMiddleware(flowsheetMirror.endShow, showDJPayload);

    // Two independent regression pins — both flip red if the `show.id == null`
    // guard is removed. Without the guard the show_end announcement re-query
    // runs (mockDbSelect) and binds `show_id = undefined`, which the eq() mock
    // rejects exactly as postgres-js does in prod — the mirror catches that
    // throw into Sentry once per guest leave (mockCaptureException). The signoff
    // is a secondary check: it stays silent either way because it is separately
    // gated on a resolved tubafrenzy show id.
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockMirrorSignoffShow).not.toHaveBeenCalled();
  });

  it('still signs off and mirrors the announcement when the primary DJ ends the show', async () => {
    const endedShowPayload = {
      id: 200,
      primary_dj_id: 'primary-dj-user-id',
      legacy_show_id: 171500,
      start_time: '2026-07-06T14:00:00.000Z',
      end_time: '2026-07-06T16:00:00.000Z',
    };

    await runMiddleware(flowsheetMirror.endShow, endedShowPayload);

    expect(mockMirrorSignoffShow).toHaveBeenCalledWith(171500, new Date('2026-07-06T16:00:00.000Z').getTime());
    // The show_end announcement re-query ran against the finalized show
    expect(mockDbSelect).toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('still signs off a show whose primary DJ account was deleted mid-show', async () => {
    // shows.primary_dj_id is nullable (onDelete: 'set null'). The guard must
    // discriminate on `id`, not primary_dj_id truthiness — startShow's guard
    // style would silently drop this signoff.
    const orphanedShowPayload = {
      id: 201,
      primary_dj_id: null,
      legacy_show_id: 171501,
      start_time: '2026-07-06T14:00:00.000Z',
      end_time: '2026-07-06T16:00:00.000Z',
    };

    await runMiddleware(flowsheetMirror.endShow, orphanedShowPayload);

    expect(mockMirrorSignoffShow).toHaveBeenCalledWith(171501, new Date('2026-07-06T16:00:00.000Z').getTime());
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
