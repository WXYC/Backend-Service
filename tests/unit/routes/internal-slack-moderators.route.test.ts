/**
 * Unit tests for /internal/slack-ban-moderators (BS#2045).
 *
 * Same X-Internal-Key / ROM_INTERNAL_KEY gate as the structural donor
 * (/internal/banned-fingerprints, BS#1261). Mock pattern follows
 * internal-bans.route.test.ts: a single shared mockChain whose terminal
 * method is overridable per test via mockResolvedValueOnce. The read
 * terminal here is `.orderBy(...)` rather than `.limit(...)` — this
 * endpoint is deliberately unpaginated (see the route's comment).
 *
 * The advisory lock, the READ COMMITTED interleaving it prevents, and the
 * audit-column preservation of the differential replace can only be
 * exercised against real Postgres — see
 * tests/integration/internal-slack-ban-moderators.spec.js.
 */

import { db } from '@wxyc/database';
import express from 'express';
import request from 'supertest';

process.env.ROM_INTERNAL_KEY = 'test-rom-secret-key';

import { internalSlackModeratorsRoute } from '../../../apps/backend/routes/internal-slack-moderators.route';

const mockDb = db as unknown as Record<string, jest.Mock>;
const mockChain = mockDb.select();
const mockOrderBy = jest.fn();
(mockChain as Record<string, jest.Mock>).orderBy = mockOrderBy;

const app = express();
app.use(express.json());
app.use('/internal/slack-ban-moderators', internalSlackModeratorsRoute);

const KEY = 'test-rom-secret-key';
const U1 = 'U01ABCDEF';
const U2 = 'U02GHIJKL';
const ACTOR = 'U09ADMIN01';

const ROUTE = '/internal/slack-ban-moderators';

function row(slackUserId: string, addedBy: string | null = null) {
  return {
    slack_user_id: slackUserId,
    added_at: new Date('2026-08-08T12:00:00Z'),
    added_by_slack_user_id: addedBy,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks() does NOT drain mockResolvedValueOnce queues; reset the
  // per-call mock fully so a stale queued value from a short-circuit test
  // can't leak into the next test.
  mockOrderBy.mockReset();
});

describe('GET /internal/slack-ban-moderators', () => {
  it('returns 401 without X-Internal-Key header', async () => {
    const res = await request(app).get(ROUTE);
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong key', async () => {
    const res = await request(app).get(ROUTE).set('X-Internal-Key', 'wrong');
    expect(res.status).toBe(401);
  });

  it('returns 200 with an empty items array when no moderators exist', async () => {
    mockOrderBy.mockResolvedValueOnce([]);
    const res = await request(app).get(ROUTE).set('X-Internal-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('returns 200 with the full moderator set (no pagination envelope)', async () => {
    mockOrderBy.mockResolvedValueOnce([row(U1, ACTOR), row(U2)]);
    const res = await request(app).get(ROUTE).set('X-Internal-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].slack_user_id).toBe(U1);
    expect(res.body.items[0].added_by_slack_user_id).toBe(ACTOR);
    expect(res.body).not.toHaveProperty('nextCursor');
  });

  it('returns 500 when the query throws', async () => {
    mockOrderBy.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).get(ROUTE).set('X-Internal-Key', KEY);
    expect(res.status).toBe(500);
  });
});

describe('PUT /internal/slack-ban-moderators — auth + validation', () => {
  it('returns 401 without X-Internal-Key header', async () => {
    const res = await request(app)
      .put(ROUTE)
      .send({ slackUserIds: [U1], expectedCurrent: [] });
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong key', async () => {
    const res = await request(app)
      .put(ROUTE)
      .set('X-Internal-Key', 'wrong')
      .send({ slackUserIds: [U1], expectedCurrent: [] });
    expect(res.status).toBe(401);
  });

  it.each([
    ['slackUserIds missing', { expectedCurrent: [] }],
    ['slackUserIds not an array', { slackUserIds: U1, expectedCurrent: [] }],
    ['slackUserIds member not a string', { slackUserIds: [42], expectedCurrent: [] }],
    ['slackUserIds member empty', { slackUserIds: [''], expectedCurrent: [] }],
    ['slackUserIds member over length cap', { slackUserIds: ['U'.repeat(65)], expectedCurrent: [] }],
    ['slackUserIds member with bad characters', { slackUserIds: ['U01-ABC'], expectedCurrent: [] }],
    [
      'slackUserIds over the 100-entry cap',
      { slackUserIds: Array.from({ length: 101 }, (_, i) => `U${i}`), expectedCurrent: [] },
    ],
  ])('returns 400 when %s', async (_label, body) => {
    const res = await request(app).put(ROUTE).set('X-Internal-Key', KEY).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/slackUserIds/);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['expectedCurrent missing', { slackUserIds: [U1] }],
    ['expectedCurrent not an array', { slackUserIds: [U1], expectedCurrent: U1 }],
    ['expectedCurrent member not a string', { slackUserIds: [U1], expectedCurrent: [42] }],
    ['expectedCurrent member with bad characters', { slackUserIds: [U1], expectedCurrent: ['U01-ABC'] }],
  ])('returns 400 when %s', async (_label, body) => {
    const res = await request(app).put(ROUTE).set('X-Internal-Key', KEY).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expectedCurrent/);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-string', 42],
    ['an empty string', ''],
    ['over the length cap', 'U'.repeat(65)],
    ['bad characters', 'U09-ADMIN'],
  ])('returns 400 when actorSlackUserId is %s', async (_label, actor) => {
    const res = await request(app)
      .put(ROUTE)
      .set('X-Internal-Key', KEY)
      .send({ slackUserIds: [U1], expectedCurrent: [], actorSlackUserId: actor });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/actorSlackUserId/);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('accepts an omitted actorSlackUserId', async () => {
    mockOrderBy.mockResolvedValueOnce([]).mockResolvedValueOnce([row(U1)]);
    const res = await request(app)
      .put(ROUTE)
      .set('X-Internal-Key', KEY)
      .send({ slackUserIds: [U1], expectedCurrent: [] });
    expect(res.status).toBe(200);
    expect(mockDb.insert).toHaveBeenCalled();
    expect((mockChain as Record<string, jest.Mock>).values).toHaveBeenCalledWith([
      { slack_user_id: U1, added_by_slack_user_id: null },
    ]);
  });
});

describe('PUT /internal/slack-ban-moderators — replace semantics', () => {
  it('takes the advisory lock before reading the live set', async () => {
    mockOrderBy.mockResolvedValueOnce([]).mockResolvedValueOnce([row(U1)]);
    await request(app)
      .put(ROUTE)
      .set('X-Internal-Key', KEY)
      .send({ slackUserIds: [U1], expectedCurrent: [] });

    expect(mockDb.execute).toHaveBeenCalled();
    // The lock statement is issued first — before the SELECT whose result
    // the expectedCurrent comparison trusts.
    const lockOrder = mockDb.execute.mock.invocationCallOrder[0];
    const readOrder = mockOrderBy.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(readOrder);
  });

  it('returns 200 and the new list when expectedCurrent matches', async () => {
    mockOrderBy.mockResolvedValueOnce([row(U1)]).mockResolvedValueOnce([row(U1), row(U2, ACTOR)]);

    const res = await request(app)
      .put(ROUTE)
      .set('X-Internal-Key', KEY)
      .send({ slackUserIds: [U1, U2], expectedCurrent: [U1], actorSlackUserId: ACTOR });

    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { slack_user_id: string }) => r.slack_user_id)).toEqual([U1, U2]);
    expect(mockDb.delete).toHaveBeenCalled();
    expect((mockChain as Record<string, jest.Mock>).values).toHaveBeenCalledWith([
      { slack_user_id: U1, added_by_slack_user_id: ACTOR },
      { slack_user_id: U2, added_by_slack_user_id: ACTOR },
    ]);
  });

  it('returns 409 with the live set and writes nothing when expectedCurrent is stale', async () => {
    mockOrderBy.mockResolvedValueOnce([row(U1), row(U2)]);

    const res = await request(app)
      .put(ROUTE)
      .set('X-Internal-Key', KEY)
      .send({ slackUserIds: [U1], expectedCurrent: [U1] });

    expect(res.status).toBe(409);
    expect(res.body.current).toEqual([U1, U2]);
    expect(mockDb.delete).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('does not 409 when the only difference is letter case (normalization guard)', async () => {
    mockOrderBy.mockResolvedValueOnce([row(U1)]).mockResolvedValueOnce([row(U1)]);

    const res = await request(app)
      .put(ROUTE)
      .set('X-Internal-Key', KEY)
      .send({ slackUserIds: [U1.toLowerCase()], expectedCurrent: [U1.toLowerCase()] });

    expect(res.status).toBe(200);
    expect((mockChain as Record<string, jest.Mock>).values).toHaveBeenCalledWith([
      { slack_user_id: U1, added_by_slack_user_id: null },
    ]);
  });

  it('collapses duplicate ids in the request to one row', async () => {
    mockOrderBy.mockResolvedValueOnce([]).mockResolvedValueOnce([row(U1)]);

    const res = await request(app)
      .put(ROUTE)
      .set('X-Internal-Key', KEY)
      .send({ slackUserIds: [U1, U1, U1.toLowerCase()], expectedCurrent: [] });

    expect(res.status).toBe(200);
    expect((mockChain as Record<string, jest.Mock>).values).toHaveBeenCalledWith([
      { slack_user_id: U1, added_by_slack_user_id: null },
    ]);
  });

  it('accepts an empty slackUserIds and skips the INSERT entirely', async () => {
    // drizzle-orm's `.values([])` raises rather than emitting a no-op, so the
    // one legal request that empties the table would 500 without the guard.
    mockOrderBy.mockResolvedValueOnce([row(U1)]).mockResolvedValueOnce([]);

    const res = await request(app)
      .put(ROUTE)
      .set('X-Internal-Key', KEY)
      .send({ slackUserIds: [], expectedCurrent: [U1] });

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(mockDb.delete).toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('logs the computed diff with the acting Slack user', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockOrderBy.mockResolvedValueOnce([row(U1)]).mockResolvedValueOnce([row(U2, ACTOR)]);

    await request(app)
      .put(ROUTE)
      .set('X-Internal-Key', KEY)
      .send({ slackUserIds: [U2], expectedCurrent: [U1], actorSlackUserId: ACTOR });

    const logged = logSpy.mock.calls.map((args) => JSON.stringify(args)).join(' ');
    expect(logged).toContain(U2); // added
    expect(logged).toContain(U1); // removed
    expect(logged).toContain(ACTOR); // actor
    logSpy.mockRestore();
  });

  it('returns 500 when the transaction throws', async () => {
    mockOrderBy.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app)
      .put(ROUTE)
      .set('X-Internal-Key', KEY)
      .send({ slackUserIds: [U1], expectedCurrent: [] });
    expect(res.status).toBe(500);
  });
});
