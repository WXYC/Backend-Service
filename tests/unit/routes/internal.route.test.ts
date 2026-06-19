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
//   1. Show resolution `select.from.leftJoin.where.limit` → returns
//      [{ id, dj_name }] (dj_name resolved via the COALESCE expression) or [].
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
    // resolveShow, resolveAlbumId, resolveRotationId. They dispatch in
    // declaration order and the mocked driver resolves them FIFO. Default
    // queue resolves the show (with a resolved dj_name) but not the album
    // or rotation (unlinked path); tests that need a resolved album_id or
    // rotation_id queue their own values before triggering the request.
    // The show row's `dj_name` is the COALESCE expression evaluated by the
    // mocked driver; tests covering BS#1371 marker-name resolution control
    // it by queuing their own values.
    mockReturning.mockReset();
    mockReturning.mockResolvedValue([{ id: 5555 }]);
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'Default Test DJ' }])
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
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'Default Test DJ' }])
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

  // -- radio_hour ingestion (BS#1449). tubafrenzy#593 adds `radioHour` (epoch
  // ms, the authoritative top-of-hour) to the breakpoint webhook payload. BS
  // persists it only for breakpoint rows; everything else stays null.

  it('writes radio_hour for a breakpoint INSERT when radioHour is present', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 8, radioHour: 1718726400000 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(
      expect.objectContaining({ entry_type: 'breakpoint', radio_hour: new Date(1718726400000) })
    );
  });

  it('writes radio_hour: null on a breakpoint INSERT when radioHour is absent (pre-#593)', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 8 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ entry_type: 'breakpoint', radio_hour: null }));
  });

  it('writes radio_hour: null (not an Invalid Date) on a breakpoint INSERT with a malformed radioHour', async () => {
    // Hardening: resolveRadioHour routes through epochMsToDate, so a
    // contract-violating non-numeric/out-of-range radioHour degrades to null
    // rather than persisting an Invalid Date or 500-ing the delivery.
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 8, radioHour: 'not-a-number' } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ entry_type: 'breakpoint', radio_hour: null }));
  });

  it('writes radio_hour: null on a track INSERT even when radioHour is present', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 0, radioHour: 1718726400000 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ entry_type: 'track', radio_hour: null }));
  });

  it('forwards the resolved rotation_id when rotationReleaseId matches a rotation row', async () => {
    // resolveShow → 9999, resolveAlbumId → unlinked, resolveRotationId → 4242.
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'Default Test DJ' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 4242 }])
      .mockResolvedValue([]); // BS#1444 sibling-heal probe finds no unhealed marker
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
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'Default Test DJ' }])
      .mockResolvedValueOnce([{ id: 7777 }])
      .mockResolvedValueOnce([{ id: 4242 }])
      .mockResolvedValue([]); // BS#1444 sibling-heal probe finds no unhealed marker
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, rotationReleaseId: 12345 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ album_id: 7777, rotation_id: 4242 }));
  });

  // -- dj_name resolution on marker entry types (BS#1371) --
  //
  // The v2 wire surfaces dj_name on show_start / show_end / dj_join / dj_leave
  // (FLOWSHEET_DJ_NAME_NON_NULL contract in wxyc-shared). Pre-#1371 the
  // webhook handler wrote dj_name=NULL on every row regardless of entry type,
  // leaving the v2 endpoint to emit `''` and iOS to render an empty handle.
  // The fix: resolve dj_name via the same COALESCE expression the ETL +
  // flowsheet-dj-name-backfill use and write it on marker INSERTs.

  it('writes resolved dj_name on a show_start INSERT (flowsheetEntryType=9)', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: "T'mia Powell" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ entry_type: 'show_start', dj_name: "T'mia Powell" }));
  });

  it('writes resolved dj_name on a show_end INSERT (flowsheetEntryType=10)', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'Iman Amadou' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 10 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ entry_type: 'show_end', dj_name: 'Iman Amadou' }));
  });

  it('writes dj_name: null on a show_start INSERT when the show has no resolvable name', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ entry_type: 'show_start', dj_name: null }));
  });

  it('writes dj_name: null on a track INSERT even when the show has a resolved dj_name', async () => {
    // Track rows have their own dj_name population path (search hot path,
    // populated by the flowsheet ETL + live insert). The webhook leaves
    // dj_name null on track INSERTs so the ETL / backfill stays the single
    // writer for that column on track rows.
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: "T'mia Powell" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: validEntry });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ entry_type: 'track', dj_name: null }));
  });

  it('writes dj_name: null on a talkset INSERT (flowsheetEntryType=7) regardless of show name', async () => {
    // talkset / breakpoint / message rows aren't attributed to a DJ. The
    // webhook leaves dj_name null so the v2 wire emits the message body.
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: "T'mia Powell" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 7 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ entry_type: 'talkset', dj_name: null }));
  });

  it('writes dj_name: null on a marker INSERT when radioShowId is 0 (no show)', async () => {
    // All three resolvers short-circuit: radioShowId=0 → resolveShow returns
    // null without a SELECT; libraryReleaseId=0 → resolveAlbumId same;
    // rotationReleaseId=0 → resolveRotationId same. Pin all three explicitly
    // (vs. inheriting the beforeEach default queue, which would survive only
    // because none of the limits are consumed) so a future regression that
    // restored the SELECT call would fail loudly rather than silently consume
    // the wrong mock entry.
    mockLimit.mockReset();
    mockReturning.mockReset();
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({
        action: 'create',
        entry: { ...validEntry, flowsheetEntryType: 9, radioShowId: 0, libraryReleaseId: 0, rotationReleaseId: 0 },
      });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(
      expect.objectContaining({
        entry_type: 'show_start',
        show_id: null,
        album_id: null,
        rotation_id: null,
        dj_name: null,
      })
    );
    expect(mockLimit).not.toHaveBeenCalled();
  });

  // -- ON CONFLICT UPDATE dj_name refresh (BS#1371 defense-in-depth) --
  //
  // The fresh-INSERT path writes `dj_name` for marker entry types. The
  // conflict-UPDATE path now refreshes it when the resolver returned a
  // non-null value, so a stub-show first-delivery that landed dj_name=NULL
  // can heal on a later redelivery once the ETL has filled
  // shows.legacy_dj_name. We never overwrite a non-NULL stored value with
  // NULL — that would regress rows the live path or a prior delivery
  // already resolved.

  const mockUpdate = (db as unknown as { update: jest.Mock }).update;
  const lastUpdateSet = (): Record<string, unknown> => {
    const setMock = (mockChain as unknown as { set: jest.Mock }).set;
    return setMock.mock.calls[0]![0] as Record<string, unknown>;
  };

  it('UPDATE on conflict refreshes dj_name for a marker entry when the show resolves to a non-null name', async () => {
    // resolveShow → {id:9999, dj_name:'Aubrey'}; INSERT conflict (empty
    // returning); handler falls through to UPDATE.
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'Aubrey' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([]); // conflict signal

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9 } });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
    expect(lastUpdateSet()).toEqual(expect.objectContaining({ entry_type: 'show_start', dj_name: 'Aubrey' }));
  });

  it('UPDATE on conflict OMITS dj_name when the show resolves to null (never overwrite non-NULL with NULL)', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([]); // conflict signal

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9 } });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
    const setClause = lastUpdateSet();
    expect(setClause).not.toHaveProperty('dj_name');
    expect(setClause).toEqual(expect.objectContaining({ entry_type: 'show_start' }));
  });

  // -- ON CONFLICT UPDATE radio_hour refresh (BS#1449 self-heal) --
  //
  // A breakpoint row inserted before the radio_hour column existed (NULL) heals
  // on a later redelivery once tubafrenzy#593 ships `radioHour`. Mirrors the
  // dj_name conditional: only set when present, never on non-breakpoints.

  it('UPDATE on conflict refreshes radio_hour for a breakpoint with radioHour', async () => {
    mockReturning.mockResolvedValueOnce([]); // conflict signal

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 8, radioHour: 1718726400000 } });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
    expect(lastUpdateSet()).toEqual(
      expect.objectContaining({ entry_type: 'breakpoint', radio_hour: new Date(1718726400000) })
    );
  });

  it('UPDATE on conflict OMITS radio_hour for a breakpoint without radioHour (never overwrite with NULL)', async () => {
    mockReturning.mockResolvedValueOnce([]); // conflict signal

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 8 } });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
    expect(lastUpdateSet()).not.toHaveProperty('radio_hour');
  });

  it('UPDATE on conflict OMITS radio_hour for a track even when radioHour is present', async () => {
    mockReturning.mockResolvedValueOnce([]); // conflict signal

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', entry: { ...validEntry, flowsheetEntryType: 0, radioHour: 1718726400000 } });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
    expect(lastUpdateSet()).not.toHaveProperty('radio_hour');
  });

  it('UPDATE on conflict OMITS dj_name on a track entry (non-marker entry types never set dj_name)', async () => {
    mockReturning.mockResolvedValueOnce([]); // conflict signal

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', entry: validEntry });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
    const setClause = lastUpdateSet();
    expect(setClause).not.toHaveProperty('dj_name');
    expect(setClause).toEqual(expect.objectContaining({ entry_type: 'track' }));
  });

  // -- Sibling-marker heal probe-before-write (BS#1444) --
  //
  // The heal SELECTs for a still-NULL marker first and only issues the
  // watermark-touching UPDATE when one exists. These two tests pin that
  // behaviour: a regression back to an unconditional UPDATE (the round-1
  // over-fire that re-touches flowsheet_watermark on every delivery) would
  // flip the "no UPDATE" assertion below.

  it('heal fires a dj_name-only UPDATE when the probe finds an unhealed marker (BS#1444)', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'Aubrey' }]) // resolveShow
      .mockResolvedValueOnce([]) // resolveAlbumId (unlinked)
      .mockResolvedValueOnce([{ id: 4242 }]) // heal probe → an unhealed marker exists
      .mockResolvedValue([]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]); // fresh INSERT (created=true)

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: validEntry }); // track → fresh insert, no conflict UPDATE

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
    // The only UPDATE is the heal: dj_name alone (the conflict refresh would
    // also carry entry_type), proving the probe-hit path issued it.
    expect(lastUpdateSet()).toEqual({ dj_name: 'Aubrey' });
  });

  it('heal issues NO UPDATE when the probe finds no unhealed marker (BS#1444 watermark guard)', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'Aubrey' }]) // resolveShow
      .mockResolvedValueOnce([]) // resolveAlbumId
      .mockResolvedValueOnce([]) // heal probe → nothing to heal
      .mockResolvedValue([]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]); // fresh INSERT (created=true)

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: validEntry });

    expect(res.status).toBe(200);
    // Fresh insert → no conflict UPDATE; empty probe → no heal UPDATE. A bare
    // unconditional heal would re-touch the watermark here on every delivery.
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('INSERT trims whitespace-only resolved dj_name to null on a marker entry', async () => {
    // shows.legacy_dj_name='   ' (whitespace) — without normalizeMarkerName
    // this would persist as '   ' and v2 wire would emit whitespace.
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: '   ' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ entry_type: 'show_start', dj_name: null }));
  });

  it('INSERT trims surrounding whitespace from resolved dj_name on a marker entry', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: '  Aubrey  ' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9 } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ entry_type: 'show_start', dj_name: 'Aubrey' }));
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
