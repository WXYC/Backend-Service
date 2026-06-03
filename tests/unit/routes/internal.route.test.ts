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
    // Each webhook call issues three .limit(1) SELECTs in `Promise.all`:
    // resolveShowId, resolveAlbumId, resolveRotationId. They dispatch in
    // declaration order and the mocked driver resolves them FIFO. Default
    // queue resolves the show but not the album or rotation (unlinked
    // path); tests that need a resolved album_id or rotation_id queue
    // their own values before triggering the request.
    mockReturning.mockReset();
    mockReturning.mockResolvedValue([{ id: 5555 }]);
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999 }])
      .mockResolvedValueOnce([])
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

  // -- libraryReleaseId → album_id + rotationReleaseId → rotation_id resolution
  // (BS#1028, BS#1268). Tubafrenzy sends both `libraryReleaseId` and
  // `rotationReleaseId` on the flowsheet webhook (set by
  // `FlowsheetEntryAddServlet.populateRotationRelease()`). BS resolves them
  // and writes the resolved IDs into the fresh-INSERT row's `album_id` and
  // `rotation_id`. The conflict-UPDATE path doesn't refresh linkage —
  // anchored to the first delivery. Post-#894 the webhook no longer fires
  // inline enrichment; CDC drives the consumer worker instead, so these
  // tests assert against the values handed to the INSERT directly.

  const mockValues = (mockChain as unknown as { values: jest.Mock }).values;
  const lastInsertValues = (): Record<string, unknown> => mockValues.mock.calls[0]![0] as Record<string, unknown>;

  it('writes the resolved album_id into the row when libraryReleaseId matches a library row', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999 }])
      .mockResolvedValueOnce([{ id: 7777 }])
      .mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: validEntry });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ album_id: 7777 }));
  });

  it('writes album_id: null when libraryReleaseId is 0 (no library link)', async () => {
    // libraryReleaseId=0 short-circuits resolveAlbumId — no album SELECT issued.
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, libraryReleaseId: 0 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ album_id: null }));
  });

  it('writes album_id: null when libraryReleaseId does not match any library row', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, libraryReleaseId: 999_999 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ album_id: null }));
  });

  it('forwards the resolved rotation_id when rotationReleaseId matches a rotation row', async () => {
    // resolveShowId → 9999, resolveAlbumId → unlinked, resolveRotationId → 4242.
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 4242 }]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, rotationReleaseId: 12345 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ rotation_id: 4242 }));
  });

  it('inserts rotation_id: null when rotationReleaseId is 0 (no rotation context)', async () => {
    // rotationReleaseId=0 short-circuits resolveRotationId — no rotation
    // SELECT issued. Default beforeEach queue handles this implicitly, but
    // we pin the contract explicitly here.
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, rotationReleaseId: 0 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ rotation_id: null }));
  });

  it('inserts rotation_id: null when rotationReleaseId does not match any rotation row', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, rotationReleaseId: 999_999 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ rotation_id: null }));
  });

  it('coexists with libraryReleaseId — both album_id and rotation_id are populated when both resolve', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999 }])
      .mockResolvedValueOnce([{ id: 7777 }])
      .mockResolvedValueOnce([{ id: 4242 }]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, rotationReleaseId: 12345 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ album_id: 7777, rotation_id: 4242 }));
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

  // BS#1082 + BS#1312: A `sendRotationLinked` linkage event sends only
  // `{id, libraryReleaseId, action: 'update'}`. Prior shape unconditionally
  // wrote defaults into rotation_bin / kill_date on every update, flipping
  // Heavy rotation rows to 'N' and clearing kill_date until the rotation-etl
  // cron tick repaired them. BS#1312 extends the gate symmetrically to the
  // three denorm fields (artist_name / album_title / record_label) used by
  // tubafrenzy + dj-site catalog views when `album_id IS NULL`.
  it('update with partial payload omits gated fields (rotation_bin, kill_date, artist_name, album_title, record_label) from SET clause', async () => {
    const onConflictSpy = (db as unknown as { _chain: { onConflictDoUpdate: jest.Mock } })._chain.onConflictDoUpdate;
    onConflictSpy.mockClear();

    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', release: { id: 500, libraryReleaseId: 0 } });

    expect(res.status).toBe(200);
    expect(onConflictSpy).toHaveBeenCalledTimes(1);
    const setClause = (onConflictSpy.mock.calls[0][0] as { set: Record<string, unknown> }).set;
    expect(setClause).not.toHaveProperty('rotation_bin');
    expect(setClause).not.toHaveProperty('kill_date');
    expect(setClause).not.toHaveProperty('artist_name');
    expect(setClause).not.toHaveProperty('album_title');
    expect(setClause).not.toHaveProperty('record_label');
  });

  // Companion to the above: when the payload DOES carry the gated fields (the
  // create path, or a full-shape update), all five must still appear in SET
  // so the update overwrites them.
  it('update with full payload keeps gated fields (rotation_bin, kill_date, artist_name, album_title, record_label) in SET clause', async () => {
    const onConflictSpy = (db as unknown as { _chain: { onConflictDoUpdate: jest.Mock } })._chain.onConflictDoUpdate;
    onConflictSpy.mockClear();

    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', release: validRelease });

    expect(res.status).toBe(200);
    expect(onConflictSpy).toHaveBeenCalledTimes(1);
    const setClause = (onConflictSpy.mock.calls[0][0] as { set: Record<string, unknown> }).set;
    expect(setClause).toHaveProperty('rotation_bin');
    expect(setClause).toHaveProperty('kill_date');
    expect(setClause).toHaveProperty('artist_name');
    expect(setClause).toHaveProperty('album_title');
    expect(setClause).toHaveProperty('record_label');
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
