/**
 * Tests for bidirectional sync loop prevention in the flowsheet mirror.
 *
 * Verifies that:
 * - addEntry skips mirroring when legacy_entry_id is non-null (ETL-imported)
 * - addEntry persists the tubafrenzy ID to legacy_entry_id after POST
 * - updateEntry skips mirroring for ETL-imported entries (not in cache)
 */

// --- Mocks ---

const mockMirrorCreateEntry = jest.fn();
const mockMirrorUpdateEntry = jest.fn();
const mockCacheEntryId = jest.fn();
const mockCacheShowId = jest.fn();
const mockGetCachedEntryId = jest.fn();
const mockGetCachedShowId = jest.fn().mockReturnValue(undefined);
const mockMapEntryToTubafrenzy = jest.fn().mockReturnValue({ artistName: 'test' });
const mockMapUpdateToTubafrenzy = jest.fn().mockReturnValue({ artistName: 'test' });

jest.mock('../../../../apps/backend/middleware/legacy/http.mirror', () => ({
  mirrorCreateEntry: mockMirrorCreateEntry,
  mirrorCreateShow: jest.fn(),
  mirrorSignoffShow: jest.fn(),
  mirrorUpdateEntry: mockMirrorUpdateEntry,
  cacheEntryId: mockCacheEntryId,
  cacheShowId: mockCacheShowId,
  getCachedEntryId: mockGetCachedEntryId,
  getCachedShowId: mockGetCachedShowId,
  clearEntryIdMap: jest.fn(),
  clearShowIdMap: jest.fn(),
  mapEntryToTubafrenzy: mockMapEntryToTubafrenzy,
  mapShowToTubafrenzy: jest.fn(),
  mapUpdateToTubafrenzy: mockMapUpdateToTubafrenzy,
}));

const mockDbUpdate = jest.fn().mockReturnValue({
  set: jest.fn().mockReturnValue({
    where: jest.fn().mockResolvedValue(undefined),
  }),
});

// Configurable per-test: default resolves to [] (no results)
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

jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
}));

const mockIsActiveRotationMatch = jest.fn().mockResolvedValue(false);
jest.mock('../../../../apps/backend/middleware/legacy/rotation-match.mirror', () => ({
  isActiveRotationMatch: mockIsActiveRotationMatch,
}));

import { runMiddleware } from './http-mirror-harness';

// Import the middleware AFTER all mocks are set up
import { flowsheetMirror } from '../../../../apps/backend/middleware/legacy/flowsheet.mirror';

describe('mirror loop prevention', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedEntryId.mockReturnValue(undefined);
    mockSelectLimitResult = [];
    // jest.clearAllMocks() only clears call history (mock.calls/results) —
    // it does NOT clear the queued `mockResolvedValueOnce(true)` impls or
    // the default `mockResolvedValue(false)` set at module-load. A queued
    // Once that the test under it never consumed (e.g., because an
    // earlier `expect` throw bypassed the helper call) would leak into
    // the next test. Use `mockReset()` to clear both queue and impl, then
    // re-stamp the module-load default so subsequent tests see "no match"
    // unless they explicitly opt into a positive case via mockResolvedValueOnce.
    mockIsActiveRotationMatch.mockReset();
    mockIsActiveRotationMatch.mockResolvedValue(false);
  });

  const baseEntry = {
    id: 42,
    show_id: 100,
    album_id: null,
    rotation_id: null,
    legacy_entry_id: null as number | null,
    entry_type: 'track',
    track_title: 'VI Scose Poise',
    album_title: 'Confield',
    artist_name: 'Autechre',
    record_label: 'Warp',
    play_order: 1,
    request_flag: false,
    segue: false,
    message: null as string | null,
    add_time: new Date('2024-02-01T12:00:00Z').toISOString(),
  };

  describe('addEntry', () => {
    it('mirrors normally when legacy_entry_id is null', (done) => {
      mockMirrorCreateEntry.mockResolvedValue(99);

      void runMiddleware(flowsheetMirror.addEntry, { ...baseEntry, legacy_entry_id: null }).then(() => {
        expect(mockMapEntryToTubafrenzy).toHaveBeenCalled();
        expect(mockMirrorCreateEntry).toHaveBeenCalled();
        done();
      });
    });

    it('skips mirroring when legacy_entry_id is non-null (ETL-imported)', (done) => {
      void runMiddleware(flowsheetMirror.addEntry, { ...baseEntry, legacy_entry_id: 12345 }).then(() => {
        expect(mockMirrorCreateEntry).not.toHaveBeenCalled();
        done();
      });
    });

    it('persists tubafrenzy ID to legacy_entry_id after successful POST', (done) => {
      mockMirrorCreateEntry.mockResolvedValue(99);

      void runMiddleware(flowsheetMirror.addEntry, { ...baseEntry, legacy_entry_id: null }).then(() => {
        expect(mockCacheEntryId).toHaveBeenCalledWith(1, 99);
        expect(mockDbUpdate).toHaveBeenCalled();
        done();
      });
    });

    it('does not persist legacy_entry_id when POST fails', (done) => {
      mockMirrorCreateEntry.mockResolvedValue(null);

      void runMiddleware(flowsheetMirror.addEntry, { ...baseEntry, legacy_entry_id: null }).then(() => {
        expect(mockCacheEntryId).not.toHaveBeenCalled();
        expect(mockDbUpdate).not.toHaveBeenCalled();
        done();
      });
    });

    it('back-fills show ID cache after DB fallback lookup', (done) => {
      mockMirrorCreateEntry.mockResolvedValue(99);
      mockGetCachedShowId.mockReturnValue(undefined);
      mockSelectLimitResult = [{ legacy_show_id: 171500 }];

      void runMiddleware(flowsheetMirror.addEntry, { ...baseEntry, legacy_entry_id: null }).then(() => {
        expect(mockCacheShowId).toHaveBeenCalledWith(100, 171500);
        expect(mockMapEntryToTubafrenzy).toHaveBeenCalledWith(expect.anything(), 171500, false);
        done();
      });
    });

    it('does not back-fill show ID cache when DB returns null', (done) => {
      mockMirrorCreateEntry.mockResolvedValue(99);
      mockGetCachedShowId.mockReturnValue(undefined);
      mockSelectLimitResult = [{ legacy_show_id: null }];

      void runMiddleware(flowsheetMirror.addEntry, { ...baseEntry, legacy_entry_id: null }).then(() => {
        expect(mockCacheShowId).not.toHaveBeenCalled();
        expect(mockMapEntryToTubafrenzy).toHaveBeenCalledWith(expect.anything(), null, false);
        done();
      });
    });

    // BS#1432 round-2 review: pin the positive-flow propagation so a future
    // refactor that drops the `await isActiveRotationMatch(entry)` call (or
    // accidentally hard-codes the third arg to false) doesn't silently
    // regress the typed-in-rotation-play badge.
    it('propagates isRotationMatch=true to mapEntryToTubafrenzy when helper resolves true', (done) => {
      mockMirrorCreateEntry.mockResolvedValue(99);
      mockIsActiveRotationMatch.mockResolvedValueOnce(true);

      void runMiddleware(flowsheetMirror.addEntry, { ...baseEntry, legacy_entry_id: null }).then(() => {
        expect(mockIsActiveRotationMatch).toHaveBeenCalledWith(expect.objectContaining({ rotation_id: null }));
        // The default `mockSelectLimitResult = []` (empty) makes the
        // radioShowID lookup resolve to null in this test environment;
        // matcher pins the third arg specifically while accepting the
        // first two as the entry object and `null` radioShowID.
        expect(mockMapEntryToTubafrenzy).toHaveBeenCalledWith(expect.any(Object), null, true);
        done();
      });
    });
  });

  describe('updateEntry', () => {
    it('skips mirroring when legacy_entry_id is set but not in cache (ETL-imported)', (done) => {
      mockGetCachedEntryId.mockReturnValue(undefined);

      void runMiddleware(flowsheetMirror.updateEntry, { ...baseEntry, legacy_entry_id: 12345 }).then(() => {
        expect(mockMirrorUpdateEntry).not.toHaveBeenCalled();
        done();
      });
    });

    it('mirrors when cached ID exists (we created it this lifecycle)', (done) => {
      mockGetCachedEntryId.mockReturnValue(99);

      void runMiddleware(flowsheetMirror.updateEntry, { ...baseEntry, legacy_entry_id: null }).then(() => {
        // Pin both args: BS#1432 added isRotationMatch as the second arg
        // and the default-false flow must be visible at the call site so
        // a regression that drops the helper call is loud.
        expect(mockMapUpdateToTubafrenzy).toHaveBeenCalledWith(expect.anything(), false);
        expect(mockMirrorUpdateEntry).toHaveBeenCalledWith(99, expect.any(Object));
        done();
      });
    });

    // BS#1432 round-2 review: symmetric positive-case for updateEntry. Same
    // rationale as the addEntry test above — guard against a refactor that
    // silently disables the typed-in-rotation-play classification on update.
    it('propagates isRotationMatch=true to mapUpdateToTubafrenzy when helper resolves true', (done) => {
      mockGetCachedEntryId.mockReturnValue(99);
      mockIsActiveRotationMatch.mockResolvedValueOnce(true);

      void runMiddleware(flowsheetMirror.updateEntry, { ...baseEntry, legacy_entry_id: null }).then(() => {
        expect(mockIsActiveRotationMatch).toHaveBeenCalledWith(expect.objectContaining({ rotation_id: null }));
        expect(mockMapUpdateToTubafrenzy).toHaveBeenCalledWith(expect.anything(), true);
        done();
      });
    });

    it('skips message-only entries', (done) => {
      mockGetCachedEntryId.mockReturnValue(99);

      void runMiddleware(flowsheetMirror.updateEntry, {
        ...baseEntry,
        message: 'This is a message',
        legacy_entry_id: null,
      }).then(() => {
        expect(mockMirrorUpdateEntry).not.toHaveBeenCalled();
        done();
      });
    });

    it('logs warning when no tubafrenzy ID available at all', (done) => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockGetCachedEntryId.mockReturnValue(undefined);

      void runMiddleware(flowsheetMirror.updateEntry, { ...baseEntry, legacy_entry_id: null }).then(() => {
        expect(mockMirrorUpdateEntry).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[mirror]'), expect.anything());
        consoleSpy.mockRestore();
        done();
      });
    });
  });
});
