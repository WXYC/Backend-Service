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

const mockUpdateLastModified = jest.fn();
jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  updateLastModified: mockUpdateLastModified,
}));

import { db } from '@wxyc/database';
import express from 'express';
import request from 'supertest';

// Set the key before importing the route
process.env.ETL_NOTIFY_KEY = 'test-secret-key';

import { internal_route } from '../../../apps/backend/routes/internal.route';

// Make the DB mock chain's terminal methods resolve to arrays (needed by webhook handler)
const mockDb = db as unknown as Record<string, jest.Mock>;
const mockChain = mockDb.select();
(mockChain as Record<string, jest.Mock>).limit = jest.fn().mockResolvedValue([]);
(mockChain as Record<string, jest.Mock>).onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
(mockChain as Record<string, jest.Mock>).onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);

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
    expect(mockUpdateLastModified).toHaveBeenCalled();
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
    expect(mockUpdateLastModified).toHaveBeenCalled();
  });

  // -- Delete --

  it('returns 200 for valid delete', async () => {
    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'delete', entryId: 2002 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockUpdateLastModified).toHaveBeenCalled();
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
