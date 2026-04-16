/**
 * Unit tests for internal endpoints:
 * - POST /internal/flowsheet-sync-notify (ETL SSE notification)
 * - POST /internal/flowsheet-webhook (tubafrenzy webhook receiver)
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
