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
 * Since the BS#1119 follow-up, the discrimination is the positive
 * `isShowPayload` predicate passed as the registration's shouldMirror gate
 * (mirror.middleware.ts), not an in-handler `show.id == null` check — these
 * tests pin the gate's semantics: ShowDJ skips silently, an unrecognized
 * shape skips LOUDLY (console.warn), and a real Show proceeds regardless of
 * primary_dj_id nullability, resolving its tubafrenzy id through either the
 * legacy_show_id column or the in-memory cache lane.
 *
 * Harness follows mirror.loop-prevention.test.ts: real middleware, mocks only
 * at process boundaries (tubafrenzy HTTP client, database, PostHog, Sentry).
 */

// --- Mocks ---

const mockMirrorSignoffShow = jest.fn().mockResolvedValue(undefined);
const mockMirrorCreateEntry = jest.fn().mockResolvedValue(null);
const mockGetCachedShowId = jest.fn().mockReturnValue(undefined);
const mockCacheEntryId = jest.fn();
const mockMapEntryToTubafrenzy = jest.fn().mockReturnValue({ artistName: 'test' });

jest.mock('../../../../apps/backend/middleware/legacy/http.mirror', () => ({
  mirrorCreateEntry: mockMirrorCreateEntry,
  mirrorCreateShow: jest.fn(),
  mirrorSignoffShow: mockMirrorSignoffShow,
  mirrorUpdateEntry: jest.fn(),
  cacheEntryId: mockCacheEntryId,
  cacheShowId: jest.fn(),
  getCachedEntryId: jest.fn(),
  getCachedShowId: mockGetCachedShowId,
  clearEntryIdMap: jest.fn(),
  clearShowIdMap: jest.fn(),
  mapEntryToTubafrenzy: mockMapEntryToTubafrenzy,
  mapShowToTubafrenzy: jest.fn(),
  mapUpdateToTubafrenzy: jest.fn(),
}));

const mockDbUpdateWhere = jest.fn().mockResolvedValue(undefined);
const mockDbUpdate = jest.fn().mockReturnValue({
  set: jest.fn().mockReturnValue({
    where: mockDbUpdateWhere,
  }),
});

// Configurable per-test: default resolves to [] (no announcement entry found)
let mockSelectLimitResult: unknown[] = [];

// where -> limit only. The announcement query lost its ORDER BY when both
// lifecycle handlers moved to the shared `mirrorAnnouncementEntry` helper, so
// an orderBy rung here would be dead scaffolding that hides a re-added sort.
const mockDbSelect = jest.fn().mockReturnValue({
  from: jest.fn().mockReturnValue({
    where: jest.fn().mockReturnValue({
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
  flowsheet: { id: 'id', legacy_entry_id: 'legacy_entry_id', show_id: 'show_id', entry_type: 'entry_type' },
  shows: { id: 'id', legacy_show_id: 'legacy_show_id', primary_dj_id: 'primary_dj_id' },
}));

// Passthrough builders, mirroring mirror.loop-prevention.test.ts. Only the
// operators flowsheet.mirror.ts actually imports are mocked (and/desc/eq/
// isNull) so a drift between this list and the module's import surface fails
// loudly as `undefined is not a function` instead of silently no-oping.
jest.mock('drizzle-orm', () => ({
  eq: jest.fn((...args: unknown[]) => args),
  and: jest.fn((...args: unknown[]) => args),
  isNull: jest.fn((column: unknown) => ['isNull', column]),
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
    mockMirrorCreateEntry.mockResolvedValue(null);
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
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runMiddleware(flowsheetMirror.endShow, showDJPayload);

      // The shouldMirror gate (isShowPayload) skips the handler entirely:
      // nothing reaches Sentry, no announcement re-query runs, no signoff
      // fires — and a recognized ShowDJ is a SILENT skip (the loud lane is
      // reserved for unrecognized shapes, next test).
      expect(mockCaptureException).not.toHaveBeenCalled();
      expect(mockDbSelect).not.toHaveBeenCalled();
      expect(mockMirrorSignoffShow).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('skips an unrecognized payload shape LOUDLY (console.warn) without running any mirror logic', async () => {
    // Neither Show keys (id + primary_dj_id) nor the ShowDJ discriminant
    // (dj_id): the shape a future projection change could produce if it
    // strips Show's keys from the /flowsheet/end response. The mirror must
    // not go quiet without a trace.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runMiddleware(flowsheetMirror.endShow, { unexpected: true });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unrecognized show-route payload'), ['unexpected']);
      // console.warn goes to container stdout, which nothing alerts on — the
      // silent-stop lane has to reach Sentry to be a real signal.
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        expect.stringContaining('Unrecognized show-route payload'),
        expect.objectContaining({ level: 'warning', extra: { keys: ['unexpected'] } })
      );
      expect(mockDbSelect).not.toHaveBeenCalled();
      expect(mockMirrorSignoffShow).not.toHaveBeenCalled();
      expect(mockCaptureException).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('skips a Show-SHAPED payload whose id is null, loudly (id is tested by value, not presence)', async () => {
    // `'id' in data` would pass this: the key is there, the value is not. Every
    // downstream read keys on it — getCachedShowId(null), and an
    // eq(flowsheet.show_id, null) that binds NULL and matches nothing, silently
    // dropping the marker. That is BS#1119's own failure mode, so it belongs in
    // the loud lane rather than past the gate.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runMiddleware(flowsheetMirror.endShow, {
        id: null,
        primary_dj_id: 'primary-dj-user-id',
        end_time: '2026-07-06T16:00:00.000Z',
      });

      expect(mockDbSelect).not.toHaveBeenCalled();
      expect(mockMirrorSignoffShow).not.toHaveBeenCalled();
      expect(mockMirrorCreateEntry).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unrecognized show-route payload'),
        expect.any(Array)
      );
      expect(mockCaptureMessage).toHaveBeenCalled();
      expect(mockCaptureException).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('signs off, mirrors the show_end announcement, and persists its legacy_entry_id when the primary DJ ends the show', async () => {
    const endedShowPayload = {
      id: 200,
      primary_dj_id: 'primary-dj-user-id',
      legacy_show_id: 171500,
      start_time: '2026-07-06T14:00:00.000Z',
      end_time: '2026-07-06T16:00:00.000Z',
    };
    // The show_end marker row the announcement re-query finds.
    const announcementRow = { id: 7, show_id: 200, entry_type: 'show_end', play_order: 3, legacy_entry_id: null };
    mockSelectLimitResult = [announcementRow];
    mockMirrorCreateEntry.mockResolvedValue(999001);

    await runMiddleware(flowsheetMirror.endShow, endedShowPayload);

    expect(mockMirrorSignoffShow).toHaveBeenCalledWith(171500, new Date('2026-07-06T16:00:00.000Z').getTime());
    // The announcement arm actually ran end-to-end: mapped against the
    // resolved tubafrenzy show, POSTed, cached by flowsheet row id (BS#1103),
    // and persisted back to legacy_entry_id.
    expect(mockMapEntryToTubafrenzy).toHaveBeenCalledWith(announcementRow, 171500);
    expect(mockMirrorCreateEntry).toHaveBeenCalledTimes(1);
    expect(mockCacheEntryId).toHaveBeenCalledWith(7, 999001);
    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('proceeds on a Show whose primary_dj_id is null (gate discriminates on Show keys, not primary_dj_id truthiness)', async () => {
    // Guard-semantics pin ONLY: shows.primary_dj_id is nullable
    // (onDelete: 'set null') and the payload still discriminates as a Show,
    // so the mirror signs off. NOTE a real deleted-primary show cannot
    // currently reach this mirror at all — the controller routes every
    // caller to the guest-leave branch when primary_dj_id is NULL, which is
    // its own defect: BS#2093.
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

  it('signs off through the in-memory cache lane when legacy_show_id is null (restart-resilience fallback order)', async () => {
    // Pins the `getCachedShowId(show.id) ?? show.legacy_show_id` resolution:
    // a show whose legacy_show_id persist failed but whose id is in the
    // showIdMap must still sign off. Without this case, a wrong-discriminant
    // mutant (e.g. gating on legacy_show_id instead of the Show shape) passes
    // every other test in this file (BS#1119 follow-up review).
    mockGetCachedShowId.mockReturnValue(171502);
    const cacheOnlyShowPayload = {
      id: 202,
      primary_dj_id: 'primary-dj-user-id',
      legacy_show_id: null,
      start_time: '2026-07-06T14:00:00.000Z',
      end_time: '2026-07-06T16:00:00.000Z',
    };

    await runMiddleware(flowsheetMirror.endShow, cacheOnlyShowPayload);

    expect(mockGetCachedShowId).toHaveBeenCalledWith(202);
    expect(mockMirrorSignoffShow).toHaveBeenCalledWith(171502, new Date('2026-07-06T16:00:00.000Z').getTime());
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('mirrors NEITHER arm when the show has no resolvable tubafrenzy id', async () => {
    // Both lanes are exhausted: nothing cached, legacy_show_id NULL (the
    // startShow mirror failed). The signoff was already guarded; the
    // announcement arm used to fall through and POST an END_OF_SHOW with a
    // null radio-show id — an orphan entry — and then stamp legacy_entry_id on
    // the marker, hiding it from legacy-mirror-reconcile's
    // `legacy_entry_id IS NULL` sweep permanently. One guard, both arms.
    mockGetCachedShowId.mockReturnValue(undefined);
    mockSelectLimitResult = [{ id: 8, show_id: 203, entry_type: 'show_end', legacy_entry_id: null }];
    mockMirrorCreateEntry.mockResolvedValue(999002);

    await runMiddleware(flowsheetMirror.endShow, {
      id: 203,
      primary_dj_id: 'primary-dj-user-id',
      legacy_show_id: null,
      start_time: '2026-07-06T14:00:00.000Z',
      end_time: '2026-07-06T16:00:00.000Z',
    });

    expect(mockMirrorSignoffShow).not.toHaveBeenCalled();
    expect(mockMirrorCreateEntry).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
