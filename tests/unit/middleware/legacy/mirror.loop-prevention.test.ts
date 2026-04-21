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
const mockGetCachedEntryId = jest.fn();
const mockMapEntryToTubafrenzy = jest.fn().mockReturnValue({ artistName: 'test' });
const mockMapUpdateToTubafrenzy = jest.fn().mockReturnValue({ artistName: 'test' });

jest.mock('../../../../apps/backend/middleware/legacy/http.mirror', () => ({
  mirrorCreateEntry: mockMirrorCreateEntry,
  mirrorCreateShow: jest.fn(),
  mirrorSignoffShow: jest.fn(),
  mirrorUpdateEntry: mockMirrorUpdateEntry,
  cacheEntryId: mockCacheEntryId,
  cacheShowId: jest.fn(),
  getCachedEntryId: mockGetCachedEntryId,
  getCachedShowId: jest.fn().mockReturnValue(undefined),
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

import { EventEmitter } from 'events';

// Helper: create mock Express response that simulates the middleware lifecycle
function createMockRes(statusCode: number, body: Record<string, unknown>) {
  const emitter = new EventEmitter();
  const locals: Record<string, unknown> = {};
  const res = {
    statusCode,
    locals,
    getHeader: jest.fn().mockReturnValue('application/json'),
    send: jest.fn(),
    once: emitter.once.bind(emitter),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    _body: body,
  };

  // After send is called, emit 'finish' to trigger mirror logic
  res.send.mockImplementation((data: unknown) => {
    locals.mirrorData = typeof data === 'string' ? JSON.parse(data) : data;
    // Simulate Express: emit finish after send
    setTimeout(() => emitter.emit('finish'), 0);
    return res;
  });

  return res;
}

function createMockReq() {
  return {
    ip: '127.0.0.1',
    user: { id: 'test-user' },
  };
}

// Helper: call middleware and wait for the async finish handler
async function runMiddleware(
  middleware: (req: any, res: any, next: any) => Promise<void> | void,
  entry: Record<string, unknown>,
  statusCode = 201
) {
  const req = createMockReq();
  const res = createMockRes(statusCode, entry);
  const next = jest.fn();

  // Middleware may or may not return a promise
  void middleware(req, res, next);
  expect(next).toHaveBeenCalled();

  // Trigger send (which populates mirrorData and emits finish)
  res.send(JSON.stringify(entry));

  // Wait for async finish handler to complete
  await new Promise((resolve) => setTimeout(resolve, 50));
}

// Import the middleware AFTER all mocks are set up
import { flowsheetMirror } from '../../../../apps/backend/middleware/legacy/flowsheet.mirror';

describe('mirror loop prevention', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedEntryId.mockReturnValue(undefined);
    mockSelectLimitResult = [];
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
        expect(mockMapUpdateToTubafrenzy).toHaveBeenCalled();
        expect(mockMirrorUpdateEntry).toHaveBeenCalledWith(99, expect.any(Object));
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
