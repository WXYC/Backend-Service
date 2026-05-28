/**
 * Unit tests for internal endpoints:
 * - POST /internal/flowsheet-sync-notify (ETL SSE notification)
 * - POST /internal/flowsheet-webhook (tubafrenzy webhook receiver)
 * - POST /internal/rotation-sync-notify (rotation ETL SSE notification)
 * - POST /internal/rotation-webhook (tubafrenzy rotation webhook receiver)
 * - POST /internal/streaming-status-webhook (LML streaming status receiver)
 */

const mockBroadcast = jest.fn();

jest.mock('../../../apps/backend/utils/serverEvents', () => ({
  Topics: { liveFs: 'live-fs-topic' },
  FsEvents: { refetch: 'refetch' },
  serverEventsMgr: { broadcast: mockBroadcast },
}));

const mockFireAndForgetMetadataForRow = jest.fn();
jest.mock('../../../apps/backend/services/metadata/index', () => ({
  fireAndForgetMetadataForRow: mockFireAndForgetMetadataForRow,
}));

import { db } from '@wxyc/database';
import express from 'express';
import request from 'supertest';

// Set the key before importing the route
process.env.ETL_NOTIFY_KEY = 'test-secret-key';

import { internal_route } from '../../../apps/backend/routes/internal.route';

// Make the DB mock chain's terminal methods resolve appropriately for the
// webhook handler. Three chain shapes feed through `mockReturning`:
//   1. Show resolution `select.from.where.limit` → returns [{ id }] or [].
//   2. Flowsheet INSERT ... ON CONFLICT DO NOTHING RETURNING { id }
//      → returns [{ id }] when a fresh row was inserted, [] on conflict.
//   3. Flowsheet UPDATE ... WHERE ... RETURNING { id } (taken only after a
//      conflict on the INSERT) → returns [{ id }].
// Tests queue results with `mockReturning.mockResolvedValueOnce` in the order
// the handler invokes them. After replacing the xmax = 0 trick (BS#909), the
// `created` boolean comes from the INSERT's RETURNING shape: a single row
// means we just inserted (fresh); an empty array means the row pre-existed
// and we should fall through to the explicit UPDATE without firing enrichment.
const mockDb = db as unknown as Record<string, jest.Mock>;
const mockChain = mockDb.select();
// `mockChain.limit` and `mockChain.returning` are the two terminal points the
// webhook handler awaits. Everything in between (`.from`, `.where`,
// `.onConflictDoNothing`, etc.) keeps returning `mockChain` so the chain is
// composable in any order. We override only the terminals so per-test
// `mockResolvedValueOnce` queues control what each resolved branch sees.
const mockLimit = jest.fn();
(mockChain as Record<string, jest.Mock>).limit = mockLimit;
const mockReturning = jest.fn();
(mockChain as Record<string, jest.Mock>).returning = mockReturning;

const app = express();
app.use(express.json());
app.use('/internal', internal_route);

// ---- flowsheet-sync-notify (existing) ----

describe('POST /internal/flowsheet-sync-notify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 without X-Internal-Key header', async () => {
    const res = await request(app).post('/internal/flowsheet-sync-notify');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('returns 401 with wrong key', async () => {
    const res = await request(app).post('/internal/flowsheet-sync-notify').set('X-Internal-Key', 'wrong-key');

    expect(res.status).toBe(401);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('returns 200 with correct key and broadcasts refetch', async () => {
    const res = await request(app).post('/internal/flowsheet-sync-notify').set('X-Internal-Key', 'test-secret-key');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockBroadcast).toHaveBeenCalledWith('live-fs-topic', {
      type: 'refetch',
      payload: { source: 'etl' },
    });
  });
});

// ---- flowsheet-webhook (new) ----

describe('POST /internal/flowsheet-webhook', () => {
  const validEntry = {
    id: 2002,
    radioShowId: 1001,
    flowsheetEntryType: 6,
    artistName: 'Autechre',
    songTitle: 'VI Scose Poise',
    releaseTitle: 'Confield',
    labelName: 'Warp',
    startTime: 1706799600000,
    requestFlag: false,
    sequenceWithinShow: 2,
    libraryReleaseId: 101,
    rotationReleaseId: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Each webhook call issues two .limit(1) SELECTs in order: resolveShowId
    // then resolveAlbumId. Default queue resolves the show but not the album
    // (unlinked path); tests that need a resolved album_id queue their own
    // values before triggering the request.
    mockReturning.mockReset();
    mockReturning.mockResolvedValue([{ id: 5555 }]);
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999 }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
  });

  // -- Auth --

  it('returns 401 without X-Internal-Key header', async () => {
    const res = await request(app).post('/internal/flowsheet-webhook').send({ action: 'create', entry: validEntry });

    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong key', async () => {
    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'wrong-key')
      .send({ action: 'create', entry: validEntry });

    expect(res.status).toBe(401);
  });

  // -- Validation --

  it('returns 400 for missing action field', async () => {
    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ entry: validEntry });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/action/i);
  });

  it('returns 400 for invalid action', async () => {
    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'purge', entry: validEntry });

    expect(res.status).toBe(400);
  });

  it('returns 400 for create with missing entry.id', async () => {
    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, id: undefined } });

    expect(res.status).toBe(400);
  });

  it('returns 400 for delete with missing entryId', async () => {
    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'delete' });

    expect(res.status).toBe(400);
  });

  // -- Create --

  it('returns 200 for valid create and broadcasts refetch', async () => {
    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: validEntry });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockBroadcast).toHaveBeenCalledWith('live-fs-topic', {
      type: 'refetch',
      payload: { source: 'webhook' },
    });
  });

  // -- Update --

  it('returns 200 for valid update', async () => {
    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', entry: validEntry });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // -- Metadata enrichment trigger --
  //
  // Tubafrenzy is the source of ~all flowsheet inserts in production today.
  // Without this trigger, every track row arrives with all 10 metadata
  // columns NULL and the iOS app sees no album art / streaming URLs / bio.
  // The dj-site addEntry controller has its own call site; this is the
  // tubafrenzy → BS path.

  it('fires metadata enrichment on fresh INSERT (RETURNING returns one row)', async () => {
    // Replaces the xmax = 0 trick (BS#909). The INSERT ... ON CONFLICT DO
    // NOTHING RETURNING { id } either returns one row (we won the insert
    // race and the row is fresh) or an empty array (someone else inserted
    // first; we should UPDATE without firing enrichment).
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: validEntry });

    expect(res.status).toBe(200);
    expect(mockFireAndForgetMetadataForRow).toHaveBeenCalledWith({
      flowsheetId: 5555,
      albumId: undefined,
      artistName: 'Autechre',
      albumTitle: 'Confield',
      trackTitle: 'VI Scose Poise',
    });
  });

  it('does not fire enrichment when the INSERT hits ON CONFLICT (RETURNING empty)', async () => {
    // Conflict path: INSERT returns []; handler falls through to an explicit
    // UPDATE that refreshes mutable fields. The UPDATE's RETURNING yields
    // the row's id for the SSE broadcast, but enrichment must NOT fire — a
    // benign tubafrenzy retry must not re-trigger the 10-column metadata
    // rewrite + CDC/tsvector/index churn.
    mockReturning.mockResolvedValueOnce([]); // INSERT conflict
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]); // UPDATE returning

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', entry: validEntry });

    expect(res.status).toBe(200);
    expect(mockFireAndForgetMetadataForRow).not.toHaveBeenCalled();
  });

  it('handles the concurrent-INSERT race: only the winner fires enrichment', async () => {
    // Issue #909 acceptance criterion (c): concurrent INSERT race. With
    // ON CONFLICT DO NOTHING RETURNING, PG serializes the two INSERTs and
    // exactly one returns a row (the winner). The loser's INSERT RETURNING
    // is empty and the handler falls through to UPDATE without enrichment.
    // We simulate the two webhook calls in the same describe block back-to-
    // back: first call wins (RETURNING [row]), second call loses (RETURNING
    // []), then sees the existing row and UPDATEs it.

    // Winner: fresh INSERT, fires enrichment.
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);
    const winnerRes = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: validEntry });
    expect(winnerRes.status).toBe(200);
    expect(mockFireAndForgetMetadataForRow).toHaveBeenCalledTimes(1);

    // Loser: same payload, INSERT conflicts, falls through to UPDATE.
    mockReturning.mockResolvedValueOnce([]); // INSERT conflict
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]); // UPDATE returning
    const loserRes = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: validEntry });
    expect(loserRes.status).toBe(200);
    // Enrichment count must still be 1 — the loser must not re-fire.
    expect(mockFireAndForgetMetadataForRow).toHaveBeenCalledTimes(1);
  });

  it('does not fire enrichment when entry_type is not track (talkset)', async () => {
    // flowsheetEntryType=7 maps to talkset (see mapProdEntryType); message
    // entries put the artistName in `message` and clear `artist_name`.
    const talksetEntry = { ...validEntry, flowsheetEntryType: 7, artistName: 'Talkset' };
    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: talksetEntry });

    expect(res.status).toBe(200);
    expect(mockFireAndForgetMetadataForRow).not.toHaveBeenCalled();
  });

  it('does not fire enrichment when artist_name is empty', async () => {
    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, artistName: '' } });

    expect(res.status).toBe(200);
    expect(mockFireAndForgetMetadataForRow).not.toHaveBeenCalled();
  });

  it('does not fire enrichment on delete actions', async () => {
    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'delete', entryId: 2002 });

    expect(res.status).toBe(200);
    expect(mockFireAndForgetMetadataForRow).not.toHaveBeenCalled();
  });

  // -- libraryReleaseId → album_id resolution (BS#1028) --

  it('forwards the resolved album_id when libraryReleaseId matches a library row', async () => {
    mockLimit.mockReset();
    mockLimit.mockResolvedValueOnce([{ id: 9999 }]).mockResolvedValueOnce([{ id: 7777 }]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: validEntry });

    expect(res.status).toBe(200);
    expect(mockFireAndForgetMetadataForRow).toHaveBeenCalledWith({
      flowsheetId: 5555,
      albumId: 7777,
      artistName: 'Autechre',
      albumTitle: 'Confield',
      trackTitle: 'VI Scose Poise',
    });
  });

  it('forwards albumId: undefined when libraryReleaseId is 0 (no library link)', async () => {
    // libraryReleaseId=0 short-circuits resolveAlbumId — no album SELECT issued.
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, libraryReleaseId: 0 } });

    expect(res.status).toBe(200);
    expect(mockFireAndForgetMetadataForRow).toHaveBeenCalledWith({
      flowsheetId: 5555,
      albumId: undefined,
      artistName: 'Autechre',
      albumTitle: 'Confield',
      trackTitle: 'VI Scose Poise',
    });
  });

  it('forwards albumId: undefined when libraryReleaseId does not match any library row', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, libraryReleaseId: 999_999 } });

    expect(res.status).toBe(200);
    expect(mockFireAndForgetMetadataForRow).toHaveBeenCalledWith({
      flowsheetId: 5555,
      albumId: undefined,
      artistName: 'Autechre',
      albumTitle: 'Confield',
      trackTitle: 'VI Scose Poise',
    });
  });

  // -- Delete --

  it('returns 200 for valid delete', async () => {
    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'delete', entryId: 2002 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockBroadcast).toHaveBeenCalledWith('live-fs-topic', {
      type: 'refetch',
      payload: { source: 'webhook' },
    });
  });
});

// ---- rotation-sync-notify ----

describe('POST /internal/rotation-sync-notify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 without X-Internal-Key header', async () => {
    const res = await request(app).post('/internal/rotation-sync-notify');

    expect(res.status).toBe(401);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('returns 200 with correct key and broadcasts refetch', async () => {
    const res = await request(app).post('/internal/rotation-sync-notify').set('X-Internal-Key', 'test-secret-key');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockBroadcast).toHaveBeenCalledWith('live-fs-topic', {
      type: 'refetch',
      payload: { source: 'rotation-etl' },
    });
  });
});

// ---- rotation-webhook ----

describe('POST /internal/rotation-webhook', () => {
  const validRelease = {
    id: 500,
    artistName: 'Autechre',
    albumTitle: 'Confield',
    rotationType: 'H',
    labelName: 'Warp',
    addDate: 1706799600000,
    killDate: 0,
    libraryReleaseId: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -- Auth --

  it('returns 401 without X-Internal-Key header', async () => {
    const res = await request(app).post('/internal/rotation-webhook').send({ action: 'create', release: validRelease });

    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong key', async () => {
    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'wrong-key')
      .send({ action: 'create', release: validRelease });

    expect(res.status).toBe(401);
  });

  // -- Validation --

  it('returns 400 for missing action field', async () => {
    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ release: validRelease });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/action/i);
  });

  it('returns 400 for invalid action', async () => {
    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'purge', release: validRelease });

    expect(res.status).toBe(400);
  });

  it('returns 400 for create with missing release.id', async () => {
    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', release: { ...validRelease, id: undefined } });

    expect(res.status).toBe(400);
  });

  it('returns 400 for unkill with missing releaseId', async () => {
    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'unkill' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for kill with missing release.id', async () => {
    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'kill', release: {} });

    expect(res.status).toBe(400);
  });

  // -- Create --

  it('returns 200 for valid create and broadcasts refetch', async () => {
    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', release: validRelease });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockBroadcast).toHaveBeenCalledWith('live-fs-topic', {
      type: 'refetch',
      payload: { source: 'rotation-webhook' },
    });
  });

  // -- Update --

  it('returns 200 for valid update', async () => {
    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', release: validRelease });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // -- Kill --

  it('returns 200 for valid kill', async () => {
    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'kill', release: { id: 500, killDate: 1706799600000 } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockBroadcast).toHaveBeenCalledWith('live-fs-topic', {
      type: 'refetch',
      payload: { source: 'rotation-webhook' },
    });
  });

  // -- Unkill --

  it('returns 200 for valid unkill', async () => {
    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'unkill', releaseId: 500 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockBroadcast).toHaveBeenCalledWith('live-fs-topic', {
      type: 'refetch',
      payload: { source: 'rotation-webhook' },
    });
  });
});

// ---- streaming-status-webhook ----

describe('POST /internal/streaming-status-webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -- Auth (Bearer token, not X-Internal-Key) --

  it('returns 401 without Authorization header', async () => {
    const res = await request(app).post('/internal/streaming-status-webhook').send({ changes: [] });

    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong Bearer token', async () => {
    const res = await request(app)
      .post('/internal/streaming-status-webhook')
      .set('Authorization', 'Bearer wrong-key')
      .send({ changes: [] });

    expect(res.status).toBe(401);
  });

  it('returns 401 with X-Internal-Key (must use Bearer)', async () => {
    const res = await request(app)
      .post('/internal/streaming-status-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ changes: [] });

    expect(res.status).toBe(401);
  });

  // -- Validation --

  it('returns 400 when changes field is missing', async () => {
    const res = await request(app)
      .post('/internal/streaming-status-webhook')
      .set('Authorization', 'Bearer test-secret-key')
      .send({ timestamp: '2026-04-27T00:00:00Z' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('changes');
  });

  it('returns 400 when changes is not an array', async () => {
    const res = await request(app)
      .post('/internal/streaming-status-webhook')
      .set('Authorization', 'Bearer test-secret-key')
      .send({ changes: 'not-an-array' });

    expect(res.status).toBe(400);
  });

  // -- Processing --

  it('returns 200 with processed count for valid changes', async () => {
    const res = await request(app)
      .post('/internal/streaming-status-webhook')
      .set('Authorization', 'Bearer test-secret-key')
      .send({
        changes: [
          { library_release_id: 42, on_streaming: true },
          { library_release_id: 99, on_streaming: false },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(2);
    expect(res.body.errors).toBe(0);
  });

  it('returns 200 with zero counts for empty changes array', async () => {
    const res = await request(app)
      .post('/internal/streaming-status-webhook')
      .set('Authorization', 'Bearer test-secret-key')
      .send({ changes: [] });

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(0);
    expect(res.body.errors).toBe(0);
  });

  it('handles null on_streaming value', async () => {
    const res = await request(app)
      .post('/internal/streaming-status-webhook')
      .set('Authorization', 'Bearer test-secret-key')
      .send({
        changes: [{ library_release_id: 42, on_streaming: null }],
      });

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1);
  });
});
