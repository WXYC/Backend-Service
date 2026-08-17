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

// The streaming-status webhook alerts Sentry once per batch when any row fails
// (BS#1114). Mock it so the failure-surfacing path is assertable without a real
// Sentry client. Harmless to the flowsheet/rotation blocks, which don't call it.
const mockCaptureMessage = jest.fn();

jest.mock('@sentry/node', () => ({
  captureMessage: mockCaptureMessage,
  captureException: jest.fn(),
}));

// Resolves to tests/mocks/database.mock.ts under the unit-test moduleNameMapper.
// `FUTURE_TIMESTAMP_TOLERANCE_MS` is the BS#2143 bound the assertions below
// straddle — derived from the constant rather than hard-coded so tightening the
// tolerance can't leave a test asserting the wrong side of the boundary while
// still passing. tests/unit/database/etl-utils.test.ts pins the mock's copy to
// the real module's, so this value tracks production.
import { db, rotation, shows, FUTURE_TIMESTAMP_TOLERANCE_MS } from '@wxyc/database';
import { and, eq, isNull } from 'drizzle-orm';
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
// Terminal handles the rotation-webhook tests assert on. `db.insert` and
// `mockChain.insert` are the same jest.Mock (createMockDb aliases them), so
// these are the short form of the same object — no new mocking, just a name.
const mockInsert = mockDb.insert;
const mockSet = (mockChain as Record<string, jest.Mock>).set;
const mockValues = (mockChain as Record<string, jest.Mock>).values;
const mockOnConflict = (mockChain as Record<string, jest.Mock>).onConflictDoUpdate;

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

  // BS#1857 / BS#1623: a fresh INSERT still writes request_flag straight from
  // the tubafrenzy payload — the never-refresh rule scopes only to the
  // conflict-UPDATE branch (pinned separately below).
  it('writes request_flag from the payload on a fresh INSERT', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, requestFlag: true } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ request_flag: true }));
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

  // -- add_time / markerTimestamp future-bound (BS#2143). A future or
  // malformed `entry.startTime` must never reach `add_time` verbatim — see
  // the doc comment on `markerTimestamp`'s computation in
  // apps/backend/routes/internal.route.ts for the full clamp-vs-reject
  // reasoning and why a read-side predicate was rejected instead.

  it('writes add_time verbatim from an ordinary (historical) startTime', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: validEntry });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ add_time: new Date(validEntry.startTime) }));
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('clamps a startTime beyond the future tolerance to the delivery clock instead of writing it verbatim, and alerts Sentry', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);
    const beforeRequest = Date.now();
    // 12x the tolerance ahead — unambiguously beyond it, and stays beyond it
    // however the tolerance is retuned.
    const farFutureStartTime = beforeRequest + FUTURE_TIMESTAMP_TOLERANCE_MS * 12;

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, startTime: farFutureStartTime } });
    const afterRequest = Date.now();

    expect(res.status).toBe(200);
    const written = lastInsertValues().add_time as Date;
    expect(written).toBeInstanceOf(Date);
    // Clamped to "now" at handling time, not to the far-future input value.
    expect(written.getTime()).toBeGreaterThanOrEqual(beforeRequest);
    expect(written.getTime()).toBeLessThanOrEqual(afterRequest);
    expect(written.getTime()).not.toBe(farFutureStartTime);

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/startTime beyond future tolerance/),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ subsystem: 'flowsheet-webhook' }),
        extra: expect.objectContaining({
          legacy_entry_id: validEntry.id,
          rejected_start_time_raw: farFutureStartTime,
        }),
        fingerprint: ['webhook-future-add-time'],
      })
    );
  });

  it('does not clamp a startTime just inside the future tolerance', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);
    // A fifth of the tolerance ahead — inside it by construction, whatever the
    // tolerance is tuned to. (Not the exact boundary: the handler measures
    // `now` itself, a few ms after this line, so an exact-boundary offset would
    // land on the wrong side. `etl-utils.test.ts` covers the exact boundary
    // with an injected `now`.)
    const justInsideStartTime = Date.now() + Math.floor(FUTURE_TIMESTAMP_TOLERANCE_MS / 5);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, startTime: justInsideStartTime } });

    expect(res.status).toBe(200);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ add_time: new Date(justInsideStartTime) }));
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  it('does not throw and does not write an Invalid Date when startTime is malformed (non-numeric), and alerts Sentry', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);
    const beforeRequest = Date.now();

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, startTime: 'not-a-number' } });
    const afterRequest = Date.now();

    expect(res.status).toBe(200);
    const written = lastInsertValues().add_time as Date;
    expect(written).toBeInstanceOf(Date);
    expect(Number.isNaN(written.getTime())).toBe(false);
    // Falls back to the delivery clock, same as an absent startTime.
    expect(written.getTime()).toBeGreaterThanOrEqual(beforeRequest);
    expect(written.getTime()).toBeLessThanOrEqual(afterRequest);
    // But unlike an absent startTime this is an upstream defect, so it must
    // NOT be silent — before BS#2143 this class 500'd, which was wrong but
    // loud; the fix must not trade that for a silent wrong timestamp.
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringMatching(/startTime present but unparseable/),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ subsystem: 'flowsheet-webhook' }),
        extra: expect.objectContaining({
          legacy_entry_id: validEntry.id,
          unparseable_start_time_raw: 'not-a-number',
          unparseable_start_time_type: 'string',
        }),
        fingerprint: ['webhook-unparseable-start-time'],
      })
    );
  });

  // The other half of the split: the common "absent" cases must stay silent,
  // or a station-normal track row would alert on every single delivery.
  it.each([
    ['absent', undefined],
    ['zero (tubafrenzy "not set" sentinel)', 0],
    ['null', null],
  ])('falls back to the delivery clock silently when startTime is %s', async (_label, startTime) => {
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);
    const beforeRequest = Date.now();

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, startTime } });
    const afterRequest = Date.now();

    expect(res.status).toBe(200);
    const written = lastInsertValues().add_time as Date;
    expect(written.getTime()).toBeGreaterThanOrEqual(beforeRequest);
    expect(written.getTime()).toBeLessThanOrEqual(afterRequest);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
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

  // -- show_end → shows.end_time fast-path (BS#1861 option (a)) --
  //
  // The webhook's stub-show flow defers `shows.end_time` to the next
  // flowsheet-etl tick; a show_end delivery now also backfills it here, from
  // the same timestamp the marker row itself gets, guarded WHERE end_time IS
  // NULL so a redelivery (or a value the ETL already repaired) is never
  // clobbered. Each test drains the heal probe empty and forces a fresh
  // INSERT so this new update is the ONLY update call in the request,
  // keeping the shared mock chain's `.set`/`.where` call history unambiguous.

  it('sets shows.end_time from the marker timestamp on a show_end delivery', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'Iman Amadou' }]) // resolveShow
      .mockResolvedValueOnce([]) // resolveAlbumId
      .mockResolvedValueOnce([]) // heal probe → nothing to heal
      .mockResolvedValue([]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]); // fresh INSERT

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 10 } });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(shows);
    expect(lastUpdateSet()).toEqual({ end_time: new Date(validEntry.startTime) });

    const whereMock = (mockChain as unknown as { where: jest.Mock }).where;
    expect(whereMock).toHaveBeenCalledWith(and(eq(shows.id, 9999), isNull(shows.end_time)));
  });

  it('does not touch shows.end_time on a non-show_end delivery', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'Iman Amadou' }]) // resolveShow
      .mockResolvedValueOnce([]) // resolveAlbumId
      .mockResolvedValueOnce([]) // heal probe → nothing to heal
      .mockResolvedValue([]);
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]); // fresh INSERT

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: validEntry }); // track (flowsheetEntryType: 6)

    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('does not touch shows.end_time on a show_end delivery with no resolvable show (radioShowId=0)', async () => {
    mockLimit.mockReset();
    mockReturning.mockReset();
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]); // fresh INSERT

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({
        action: 'create',
        entry: { ...validEntry, flowsheetEntryType: 10, radioShowId: 0, libraryReleaseId: 0, rotationReleaseId: 0 },
      });

    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

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

  // -- ON CONFLICT UPDATE never refreshes request_flag (BS#1857 / BS#1623) --
  //
  // BS's DJ-facing PATCH /flowsheet is the authoritative writer for
  // request_flag on a live show. The conflict-refresh branch here must never
  // overwrite it from tubafrenzy's payload — that would silently revert a
  // DJ's toggle on the next redelivery. The fresh-INSERT branch (asserted
  // elsewhere in this file, e.g. "returns 200 for valid create") still writes
  // it from the payload; only the re-sync UPDATE path omits it.

  it('UPDATE on conflict OMITS request_flag regardless of the incoming payload value (BS#1857 / BS#1623)', async () => {
    mockReturning.mockResolvedValueOnce([]); // conflict signal

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', entry: { ...validEntry, requestFlag: true } });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
    expect(lastUpdateSet()).not.toHaveProperty('request_flag');
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

  // -- Stub-show naming + heal from payload djHandle (BS#1723) --
  //
  // tubafrenzy#607 adds an optional `entry.djHandle` (the show's DJ_HANDLE) to
  // sign-on/sign-off marker payloads. resolveShow uses it two ways: a stub
  // `shows` row is created WITH `legacy_dj_name`, and an existing open show
  // whose name resolves to NULL is healed in place. The heal path is the one
  // that fixes the live bug: at sign-on the BREAKPOINT delivery precedes the
  // START_OF_SHOW delivery, so the stub already exists (nameless) when the
  // handle arrives. Without this, `on_air` reports `null` (= confirmed
  // automation, "AUTO DJ" on iOS) until the */30 flowsheet-ETL tick.
  //
  // Mock-order note: the heal adds a `db.update(shows)` (no terminal await —
  // the bare chain resolves) plus ONE extra `selectShow()` re-select. Under
  // `Promise.all`, resolveAlbumId's SELECT dispatches before resolveShow's
  // continuation runs, so the re-select consumes mockLimit position 3 (after
  // show-select and album-select), then the sibling-marker probe is position
  // 4. All `db.update(...)` calls share one mock chain, so heal assertions
  // inspect the `.set()` payload — `legacy_dj_name` is a key only the shows
  // heal writes.

  const allUpdateSetCalls = (): Record<string, unknown>[] => {
    const setMock = (mockChain as unknown as { set: jest.Mock }).set;
    return setMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
  };

  const mockOnConflictDoUpdate = (mockChain as unknown as { onConflictDoUpdate: jest.Mock }).onConflictDoUpdate;

  it('creates the stub show WITH legacy_dj_name when the payload carries djHandle', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([]) // resolveShow: no existing show
      .mockResolvedValueOnce([]) // resolveAlbumId (unlinked)
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'ovni' }]) // post-insert re-select
      .mockResolvedValueOnce([]); // sibling-marker probe (nothing to heal)
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]); // fresh flowsheet INSERT

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9, djHandle: 'ovni' } });

    expect(res.status).toBe(200);
    // First .values() call is the shows stub INSERT, second is the flowsheet INSERT.
    expect(mockValues.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ legacy_show_id: 1001, legacy_dj_name: 'ovni' })
    );
    expect(mockValues.mock.calls[1]![0]).toEqual(
      expect.objectContaining({ entry_type: 'show_start', dj_name: 'ovni' })
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('arms the stub INSERT with an ON CONFLICT DO UPDATE fill so a lost concurrent-insert race still names the show', async () => {
    // The sequential sign-on race is healed by the existing-row branch, but
    // the two sign-on deliveries can also interleave so BOTH probes see no
    // row. Then the handle-bearing delivery can lose the INSERT race; a bare
    // onConflictDoNothing would discard the handle and leave the stub
    // nameless until the next ETL tick. The conflict arm must fill
    // legacy_dj_name (guarded by a never-overwrite setWhere) instead.
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([]) // resolveShow: no existing show at probe time
      .mockResolvedValueOnce([]) // resolveAlbumId
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'ovni' }]) // post-insert re-select
      .mockResolvedValueOnce([]); // sibling-marker probe
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9, djHandle: 'ovni' } });

    expect(res.status).toBe(200);
    // `target` matters: a non-unique conflict target would make PG reject the
    // INSERT ("no unique or exclusion constraint...") and 500 the webhook.
    expect(mockOnConflictDoUpdate.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({
        target: 'legacy_show_id',
        set: { legacy_dj_name: 'ovni' },
        setWhere: expect.anything(),
      }),
    ]);
  });

  it('creates the stub show WITHOUT legacy_dj_name when djHandle is absent (pins pre-#1723 behavior)', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([]) // resolveShow: no existing show
      .mockResolvedValueOnce([]) // resolveAlbumId
      .mockResolvedValueOnce([{ id: 9999, dj_name: null }]); // post-insert re-select (still nameless)
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9 } });

    expect(res.status).toBe(200);
    expect(mockValues.mock.calls[0]![0]).toEqual(expect.objectContaining({ legacy_show_id: 1001 }));
    expect(mockValues.mock.calls[0]![0]).not.toHaveProperty('legacy_dj_name');
    expect(mockValues.mock.calls[1]![0]).toEqual(expect.objectContaining({ entry_type: 'show_start', dj_name: null }));
    // No handle → nothing to fill on conflict; the stub INSERT stays DO NOTHING.
    expect(mockOnConflictDoUpdate).not.toHaveBeenCalled();
  });

  it('heals a nameless existing show from djHandle and names the marker INSERT (the sign-on race)', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: null }]) // resolveShow: stub exists, nameless
      .mockResolvedValueOnce([]) // resolveAlbumId
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'ovni' }]) // post-heal re-select
      .mockResolvedValueOnce([]); // sibling-marker probe
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9, djHandle: 'ovni' } });

    expect(res.status).toBe(200);
    expect(allUpdateSetCalls()).toEqual([{ legacy_dj_name: 'ovni' }]);
    expect(mockValues.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ entry_type: 'show_start', dj_name: 'ovni' })
    );
  });

  it('issues NO shows heal when the show already resolves a name (never overwrite)', async () => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: 'Aubrey' }]) // already named
      .mockResolvedValueOnce([]) // resolveAlbumId
      .mockResolvedValueOnce([]); // sibling-marker probe
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9, djHandle: 'ovni' } });

    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(lastInsertValues()).toEqual(expect.objectContaining({ entry_type: 'show_start', dj_name: 'Aubrey' }));
  });

  it.each([
    ['blank', ''],
    ['whitespace', '   '],
    ['non-string', 12345],
  ])('treats a %s djHandle as absent: no heal, no extra re-select', async (_label, badHandle) => {
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: null }]) // nameless show
      .mockResolvedValueOnce([]); // resolveAlbumId
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9, djHandle: badHandle } });

    expect(res.status).toBe(200);
    expect(mockUpdate).not.toHaveBeenCalled();
    // No heal → no post-heal re-select; nameless show → no sibling probe.
    expect(mockLimit).toHaveBeenCalledTimes(2);
    expect(lastInsertValues()).toEqual(expect.objectContaining({ entry_type: 'show_start', dj_name: null }));
  });

  it('truncates an over-long djHandle to 128 chars on stub create (ETL byte-parity)', async () => {
    const expected = 'x'.repeat(128);
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([]) // no existing show
      .mockResolvedValueOnce([]) // resolveAlbumId
      .mockResolvedValueOnce([{ id: 9999, dj_name: expected }]) // post-insert re-select
      .mockResolvedValueOnce([]); // sibling-marker probe
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9, djHandle: `  ${'x'.repeat(200)}  ` } });

    expect(res.status).toBe(200);
    expect(mockValues.mock.calls[0]![0]).toEqual(expect.objectContaining({ legacy_dj_name: expected }));
  });

  it('truncates an over-long djHandle to 128 chars on the heal path', async () => {
    const expected = 'x'.repeat(128);
    mockLimit.mockReset();
    mockLimit
      .mockResolvedValueOnce([{ id: 9999, dj_name: null }]) // nameless show
      .mockResolvedValueOnce([]) // resolveAlbumId
      .mockResolvedValueOnce([{ id: 9999, dj_name: expected }]) // post-heal re-select
      .mockResolvedValueOnce([]); // sibling-marker probe
    mockReturning.mockResolvedValueOnce([{ id: 5555 }]);

    const res = await request(app)
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', entry: { ...validEntry, flowsheetEntryType: 9, djHandle: 'x'.repeat(200) } });

    expect(res.status).toBe(200);
    expect(allUpdateSetCalls()).toEqual([{ legacy_dj_name: expected }]);
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
  //
  // BS#2173 replaces the presence-gated upsert with an outright UPDATE for
  // this shape. Gating the SET clause protected an EXISTING row, but the
  // INSERT arm still had to supply the NOT NULL `rotation_bin` and did so with
  // the fictional 'N' — so a linkage event for a release BS had never seen
  // materialized a phantom in-rotation row. A payload with no bin now updates
  // only, and can never create.
  it('update with partial payload updates in place and never inserts', async () => {
    mockReturning.mockResolvedValueOnce([{ id: 42 }]);

    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', release: { id: 500, libraryReleaseId: 0 } });

    expect(res.status).toBe(200);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockOnConflict).not.toHaveBeenCalled();

    const setClause = mockSet.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // The gated fields stay out...
    expect(setClause).not.toHaveProperty('rotation_bin');
    expect(setClause).not.toHaveProperty('kill_date');
    expect(setClause).not.toHaveProperty('artist_name');
    expect(setClause).not.toHaveProperty('album_title');
    expect(setClause).not.toHaveProperty('record_label');
    // ...but the two ungated ones must still be written, or the linkage this
    // whole payload shape exists to deliver (BS#1082/#1312) silently no-ops.
    // Without these, an empty `partialSet` would satisfy every assertion above.
    expect(setClause).toHaveProperty('album_id');
    expect(setClause).toHaveProperty('legacy_library_release_id');
  });

  // BS#2173: tubafrenzy's BackendServiceWebhookClient serializes a null
  // ROTATION_TYPE as "" rather than omitting the key, so "" is a THIRD spelling
  // of "no bin" alongside absent and null — not bad data. Treating it as bad
  // data would 400 the whole event and silently drop an MD's kill-date edit on
  // any of the 15 blank-bin releases. Whitespace is normalized the same way.
  it.each([[''], ['   '], [null]])('treats rotationType %p as "no bin", updating in place', async (rotationType) => {
    mockReturning.mockResolvedValueOnce([{ id: 42 }]);

    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', release: { id: 500, libraryReleaseId: 0, rotationType, killDate: 1706799600000 } });

    expect(res.status).toBe(200);
    expect(mockInsert).not.toHaveBeenCalled();
    const setClause = mockSet.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(setClause).not.toHaveProperty('rotation_bin');
    // The rest of the payload still applies — this is the arm that must NOT
    // drop the edit.
    expect(setClause).toHaveProperty('kill_date');
  });

  // The other half of the same rule: with no bin in the payload and no row to
  // update, there is nothing this handler can legally write. It must report
  // that rather than invent a bin to satisfy the NOT NULL column.
  it('returns 404 for a bin-less payload naming a rotation release BS has never seen', async () => {
    mockReturning.mockResolvedValueOnce([]);

    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', release: { id: 999_999, libraryReleaseId: 0 } });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/unknown rotation release/i);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  // 'N' is the specific value BS#2173 unwinds. Migration 0041 added it to
  // `freq_enum` for "tubafrenzy's New rotation type" — a category error, not an
  // invention: tubafrenzy's "New" is flowsheet entry-type code 5 ("new vinyl,
  // NOT yet in rotation"), explicitly not a rotation bin. A present, non-blank
  // value that isn't one of the four bins is bad data. Pinned explicitly so a
  // future re-add has to delete a named case.
  it.each([['N'], ['X'], [7], ['New']])(
    'returns 400 for a present-but-unrecognized rotationType %p',
    async (rotationType) => {
      const res = await request(app)
        .post('/internal/rotation-webhook')
        .set('X-Internal-Key', 'test-secret-key')
        .send({ action: 'create', release: { ...validRelease, rotationType } });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/rotationType/i);
      expect(mockInsert).not.toHaveBeenCalled();
    }
  );

  // Asserting the VALUE reaches the insert, not merely a 200 — a handler that
  // hardcoded one bin would pass a status-only check on all four cases, and the
  // bin being correct is the entire subject of BS#2173.
  it.each([
    ['H', 'H'],
    ['M', 'M'],
    ['L', 'L'],
    ['S', 'S'],
    [' h ', 'H'],
  ])('accepts the real rotation bin %p and inserts it as %p', async (rotationType, expected) => {
    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'create', release: { ...validRelease, rotationType } });

    expect(res.status).toBe(200);
    const values = mockValues.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(values.rotation_bin).toBe(expected);
  });

  // Companion to the above: when the payload DOES carry the gated fields (the
  // create path, or a full-shape update), all five must still appear in SET
  // so the update overwrites them.
  it('update with full payload keeps gated fields (rotation_bin, kill_date, artist_name, album_title, record_label) in SET clause', async () => {
    const onConflictSpy = mockOnConflict;
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

  // BS#2109: `album_id` is COALESCEd, not overwritten, so a webhook `update`
  // carrying `libraryReleaseId: 0` (i.e. `excluded.album_id IS NULL`) cannot
  // revert a Backend-made link from `PATCH /library/rotation/:id/link`.
  // Before this, the next /wxycdb edit on a release the librarian had
  // catalogued in dj-site reset album_id to NULL, restored the free text,
  // and dropped the row back into the cataloging queue.
  it('update with libraryReleaseId: 0 COALESCEs album_id so a Backend-made link is never downgraded to NULL', async () => {
    const onConflictSpy = (db as unknown as { _chain: { onConflictDoUpdate: jest.Mock } })._chain.onConflictDoUpdate;
    onConflictSpy.mockClear();

    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', release: { id: 500, libraryReleaseId: 0 } });

    expect(res.status).toBe(200);
    const setClause = (onConflictSpy.mock.calls[0][0] as { set: Record<string, unknown> }).set;
    // drizzle-orm is automocked project-wide, so `sql\`...\`` renders as
    // `{ sql: TemplateStringsArray, values: [...] }`. Assert on the literal
    // chunks: a bare `excluded.album_id` assignment would have no COALESCE.
    const rendered = ((setClause.album_id as { sql?: string[] })?.sql ?? []).join('?');
    expect(rendered).toContain('COALESCE(excluded.album_id');
    // The existing row is the COALESCE fallback, so tubafrenzy's NULL loses.
    expect((setClause.album_id as { values?: unknown[] })?.values).toEqual([rotation.album_id]);
  });

  // Review round 3 finding 2 narrowed this: only `legacy_library_release_id`
  // / `rotation_bin` / `kill_date` are still plain `excluded.*` assignments.
  // `artist_name` / `album_title` / `record_label` are covered by the two
  // tests below instead — they're no longer plain assignments even when
  // present, because they're now gated on the row's resolved linkage.
  it('leaves legacy_library_release_id, rotation_bin, and kill_date as plain excluded.* assignments', async () => {
    const onConflictSpy = (db as unknown as { _chain: { onConflictDoUpdate: jest.Mock } })._chain.onConflictDoUpdate;
    onConflictSpy.mockClear();

    await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', release: validRelease });

    const setClause = (onConflictSpy.mock.calls[0][0] as { set: Record<string, unknown> }).set;
    for (const column of ['legacy_library_release_id', 'rotation_bin', 'kill_date']) {
      const rendered = ((setClause[column] as { sql?: string[] })?.sql ?? []).join('?');
      expect(rendered).not.toContain('COALESCE');
      expect(rendered).not.toContain('CASE');
    }
  });

  // BS#2109 review round 3 finding 2: a `/wxycdb` edit's incoming free text
  // must not land on an already-linked row — that recreates the "album_id
  // set AND snapshot set" shape `PATCH /library/rotation/:id/link`'s 409
  // and sibling PR #2165 both exist to prevent, and that the BS#2080
  // arm-(b)/(c) rotation-badge match doesn't filter `album_id IS NULL`
  // against. `artist_name` / `album_title` / `record_label` are still
  // presence-gated (BS#1082 + BS#1312, unchanged — see the previous two
  // tests) but a present column is now a CASE, not a plain `excluded.*`
  // assignment, gated on the exact same expression assigned to `album_id`.
  it('gates artist_name/album_title/record_label on the resolved album_id rather than writing excluded.* unconditionally', async () => {
    const onConflictSpy = (db as unknown as { _chain: { onConflictDoUpdate: jest.Mock } })._chain.onConflictDoUpdate;
    onConflictSpy.mockClear();

    await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', release: validRelease });

    const setClause = (onConflictSpy.mock.calls[0][0] as { set: Record<string, unknown> }).set;
    for (const column of ['artist_name', 'album_title', 'record_label']) {
      const entry = setClause[column] as { sql?: string[]; values?: unknown[] };
      const rendered = (entry?.sql ?? []).join('?');
      expect(rendered).toContain('CASE WHEN');
      expect(rendered).toContain('IS NULL THEN');
      expect(rendered).toContain(`excluded.${column}`);
      expect(rendered).toContain('ELSE NULL END');
      // The CASE condition embeds the identical SQL fragment assigned to
      // `album_id` — checked by object identity rather than re-rendering
      // the nested SQL, since drizzle-orm's mock nests an interpolated
      // `SQL` fragment as an opaque object inside `.values` rather than
      // splicing its text into the outer `.sql` chunks.
      expect(entry?.values?.[0]).toBe(setClause.album_id);
    }
  });

  // Review round 3 finding 2's "better form": a genuinely resolvable
  // `libraryReleaseId` takes `excluded.album_id` unconditionally — not
  // COALESCEd — restoring tubafrenzy's ability to relink a row, which the
  // interim blanket-COALESCE shape had silently revoked (its own docblock's
  // claim that tubafrenzy could no longer *unlink* a row understated the
  // change: it could no longer change album_id at all).
  it('writes album_id from excluded.album_id (not COALESCEd) when the payload carries a genuine libraryReleaseId', async () => {
    const onConflictSpy = (db as unknown as { _chain: { onConflictDoUpdate: jest.Mock } })._chain.onConflictDoUpdate;
    onConflictSpy.mockClear();
    mockLimit.mockReset();
    mockLimit.mockResolvedValueOnce([{ id: 42 }]);

    const res = await request(app)
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', 'test-secret-key')
      .send({ action: 'update', release: { id: 500, libraryReleaseId: 777 } });

    expect(res.status).toBe(200);
    const setClause = (onConflictSpy.mock.calls[0][0] as { set: Record<string, unknown> }).set;
    const rendered = ((setClause.album_id as { sql?: string[] })?.sql ?? []).join('?');
    expect(rendered).not.toContain('COALESCE');
    expect(rendered).toBe('excluded.album_id');
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

  // -- Per-row isolation (BS#1114) --
  //
  // The handler previously wrapped every row's UPDATE in one `db.transaction`.
  // When a mid-loop row raised, Postgres aborted the surrounding transaction and
  // the per-row catch swallowed both the original error and every subsequent
  // `current transaction is aborted` — the response came back with a meaningless
  // `errors` count and the first row's real error lost. The fix drops the shared
  // transaction so each UPDATE autocommits independently, and surfaces the
  // failing row's actual error rather than only counting it.
  //
  // NOTE: the mocked driver can't reproduce Postgres's transaction-abort
  // poisoning (it runs the callback against the same chain), so these unit tests
  // pin the *shape* of the fix — no shared transaction, and the real error
  // surfaced. The poisoning behaviour itself is covered at the integration tier.

  const dbTransaction = (db as unknown as { transaction: jest.Mock }).transaction;

  it('does not wrap the batch in a single shared transaction', async () => {
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
    // A shared transaction is exactly what let one aborted statement swallow the
    // rest — the fix runs each row as its own autocommitted UPDATE.
    expect(dbTransaction).not.toHaveBeenCalled();
  });

  it('commits the surviving rows and surfaces the failing row with its real error', async () => {
    // Row index 1 fails; rows 0 and 2 must still commit and the failure must be
    // reported with the actual error keyed by its library_release_id — not lost
    // behind a bare `errors` count.
    const chain = mockChain as Record<string, jest.Mock>;
    chain.where
      .mockReturnValueOnce(chain) // row 0 commits
      .mockRejectedValueOnce(new Error('null value violates not-null constraint')) // row 1 fails
      .mockReturnValueOnce(chain); // row 2 commits

    const res = await request(app)
      .post('/internal/streaming-status-webhook')
      .set('Authorization', 'Bearer test-secret-key')
      .send({
        changes: [
          { library_release_id: 1, on_streaming: true },
          { library_release_id: 2, on_streaming: false },
          { library_release_id: 3, on_streaming: true },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(2);
    expect(res.body.errors).toBe(1);
    expect(res.body.failures).toEqual([
      expect.objectContaining({
        library_release_id: 2,
        error: expect.stringContaining('not-null constraint'),
      }),
    ]);
  });

  it('alerts Sentry once for a batch that had at least one failing row', async () => {
    const chain = mockChain as Record<string, jest.Mock>;
    chain.where
      .mockReturnValueOnce(chain)
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockReturnValueOnce(chain);

    const res = await request(app)
      .post('/internal/streaming-status-webhook')
      .set('Authorization', 'Bearer test-secret-key')
      .send({
        changes: [
          { library_release_id: 1, on_streaming: true },
          { library_release_id: 2, on_streaming: false },
          { library_release_id: 3, on_streaming: true },
        ],
      });

    expect(res.status).toBe(200);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      expect.stringContaining('streaming-status'),
      expect.objectContaining({ level: 'warning' })
    );
  });

  it('does not alert Sentry and returns an empty failures array when every row commits', async () => {
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
    expect(res.body.failures).toEqual([]);
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});
