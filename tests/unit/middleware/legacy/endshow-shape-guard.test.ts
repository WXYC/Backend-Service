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

    // No signoff, no announcement re-query (the re-query is what throws on the
    // undefined show_id bind in production and lands in Sentry), no error.
    expect(mockMirrorSignoffShow).not.toHaveBeenCalled();
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
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
