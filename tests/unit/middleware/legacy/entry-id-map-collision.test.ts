/**
 * BS#1103 — the in-memory entryIdMap was keyed by `play_order`, which is
 * only unique *within* a show (post-#693, play_order resets to 1 on every
 * new show). Two shows created back-to-back in the same process lifetime
 * can both cache an entry at the same play_order slot; the second show's
 * `cacheEntryId` write silently evicts the first show's cached tubafrenzy
 * ID. A subsequent PATCH on the first show's entry then resolves to the
 * SECOND show's tubafrenzy row and mirrors the edit onto the wrong show.
 *
 * This test drives the real addEntry/updateEntry middleware through two
 * mirrored shows with overlapping play_order slots, backed by a real
 * Map-based cacheEntryId/getCachedEntryId pair (not a bare jest.fn() —
 * the collision only reproduces if the mock actually behaves like the
 * production Map). Before the fix (keyed by play_order) this test is RED:
 * show A's PATCH resolves to show B's tubafrenzy ID. After the fix (keyed
 * by the globally-unique flowsheet row id) it's GREEN.
 */

// --- Mocks ---

const mockMirrorCreateEntry = jest.fn();
const mockMirrorUpdateEntry = jest.fn();

// Real Map-backed cache functions — NOT bare jest.fn()s — so the test
// actually exercises the collision the production entryIdMap is subject
// to, rather than just asserting on call arguments.
const entryIdMap = new Map<number, number>();
const mockCacheEntryId = jest.fn((key: number, tubafrenzyId: number) => {
  entryIdMap.set(key, tubafrenzyId);
});
const mockGetCachedEntryId = jest.fn((key: number) => entryIdMap.get(key));
const mockGetCachedShowId = jest.fn();

jest.mock('../../../../apps/backend/middleware/legacy/http.mirror', () => ({
  mirrorCreateEntry: mockMirrorCreateEntry,
  mirrorCreateShow: jest.fn(),
  mirrorSignoffShow: jest.fn(),
  mirrorUpdateEntry: mockMirrorUpdateEntry,
  cacheEntryId: mockCacheEntryId,
  cacheShowId: jest.fn(),
  getCachedEntryId: mockGetCachedEntryId,
  getCachedShowId: mockGetCachedShowId,
  clearEntryIdMap: jest.fn(),
  clearShowIdMap: jest.fn(),
  mapEntryToTubafrenzy: jest.fn().mockReturnValue({ artistName: 'test' }),
  mapShowToTubafrenzy: jest.fn(),
  mapUpdateToTubafrenzy: jest.fn().mockReturnValue({ artistName: 'test' }),
}));

const mockDbUpdate = jest.fn().mockReturnValue({
  set: jest.fn().mockReturnValue({
    where: jest.fn().mockResolvedValue(undefined),
  }),
});

const mockDbSelect = jest.fn().mockReturnValue({
  from: jest.fn().mockReturnValue({
    where: jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      }),
      limit: jest.fn().mockResolvedValue([]),
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

jest.mock('../../../../apps/backend/middleware/legacy/rotation-match.mirror', () => ({
  isActiveRotationMatch: jest.fn().mockResolvedValue(false),
}));

import { runMiddleware } from './http-mirror-harness';
import { flowsheetMirror } from '../../../../apps/backend/middleware/legacy/flowsheet.mirror';

const makeEntry = (overrides: Record<string, unknown>) => ({
  id: 1,
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
  ...overrides,
});

describe('entryIdMap cross-show collision (BS#1103)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    entryIdMap.clear();
    mockGetCachedShowId.mockReturnValue(171_500); // both shows resolve fine; irrelevant to the bug
  });

  it('PATCHing an earlier show entry does not target a later show entry sharing the same play_order', async () => {
    // Show A (backend show id 100): one entry at play_order=2, flowsheet row id 502.
    const entryA2 = makeEntry({ id: 502, show_id: 100, play_order: 2 });
    mockMirrorCreateEntry.mockResolvedValueOnce(5002); // show A's tubafrenzy entry id
    await runMiddleware(flowsheetMirror.addEntry, entryA2);

    // Show B (backend show id 200), created after show A ends: play_order resets,
    // so its entry also lands at play_order=2, flowsheet row id 602.
    const entryB2 = makeEntry({ id: 602, show_id: 200, play_order: 2 });
    mockMirrorCreateEntry.mockResolvedValueOnce(6002); // show B's tubafrenzy entry id
    await runMiddleware(flowsheetMirror.addEntry, entryB2);

    // PATCH show A's entry (still play_order=2, flowsheet row id 502).
    await runMiddleware(flowsheetMirror.updateEntry, entryA2);

    // Must resolve show A's tubafrenzy id (5002), never show B's (6002).
    expect(mockMirrorUpdateEntry).toHaveBeenCalledTimes(1);
    expect(mockMirrorUpdateEntry).toHaveBeenCalledWith(5002, expect.any(Object));
  });
});
