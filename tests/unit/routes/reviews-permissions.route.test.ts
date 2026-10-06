// Same real-middleware harness as intake-transitions.route.test.ts (the shared
// `@wxyc/authentication` stub ignores the permission argument). The service is mocked: who may
// edit WHICH review is pinned in tests/unit/services/reviews.service.test.ts, so this file pins the
// route grants and the controller's request parsing and outcome mapping.
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';
delete process.env.AUTH_BYPASS;

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));

jest.mock('@wxyc/authentication', () => ({
  ...jest.requireActual('../../../shared/authentication/src/auth.middleware'),
  ...jest.requireActual('../../../shared/authentication/src/auth.roles'),
}));

import { jest as jestGlobals } from '@jest/globals';
import { jwtVerify } from 'jose';
import express from 'express';
import request from 'supertest';

const mockedJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;
const mockRole = (role?: string, sub = 'caller-id') =>
  mockedJwtVerify.mockResolvedValue({
    payload: { sub, email: 'test@wxyc.org', ...(role === undefined ? {} : { role }) },
    protectedHeader: { alg: 'RS256' },
    key: {} as any,
  });

const mockCreate = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockUpdate = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockSubmit = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockDelete = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockGet = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockList = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockRevisions = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();

jest.mock('@wxyc/database', () => ({
  reviewCreditEnum: jest.requireActual('../../../shared/database/src/schema').reviewCreditEnum,
}));
const mockNotifySubmitted = jestGlobals.fn<(...args: any[]) => Promise<void>>();
jest.mock('../../../apps/backend/services/review-notices.service', () => ({
  notifyReviewSubmitted: mockNotifySubmitted,
}));
jest.mock('../../../apps/backend/services/reviews.service', () => ({
  createReview: mockCreate,
  updateReview: mockUpdate,
  submitReview: mockSubmit,
  deleteReview: mockDelete,
  getReview: mockGet,
  listReviews: mockList,
  listReviewRevisions: mockRevisions,
}));

import { reviews_route } from '../../../apps/backend/routes/reviews.route';
import errorHandler from '../../../apps/backend/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/reviews', reviews_route);
app.use(errorHandler);

const REVIEW = { id: 3, status: 'draft' };
const post = (body: object) => request(app).post('/reviews').set('Authorization', 'Bearer t').send(body);
const patch = (body: object, id = '3') =>
  request(app).patch(`/reviews/${id}`).set('Authorization', 'Bearer t').send(body);
const submit = (id = '3') => request(app).post(`/reviews/${id}/submit`).set('Authorization', 'Bearer t');
const remove = (id = '3') => request(app).delete(`/reviews/${id}`).set('Authorization', 'Bearer t');

beforeEach(() => {
  mockedJwtVerify.mockReset();
  mockCreate.mockReset().mockResolvedValue({ outcome: 'created', review: REVIEW });
  mockUpdate.mockReset().mockResolvedValue({ outcome: 'updated', review: REVIEW });
  mockSubmit.mockReset().mockResolvedValue({ outcome: 'submitted', review: REVIEW });
  mockDelete.mockReset().mockResolvedValue({ outcome: 'deleted' });
  mockGet.mockReset().mockResolvedValue(REVIEW);
  mockList.mockReset().mockResolvedValue([REVIEW]);
  mockRevisions.mockReset().mockResolvedValue([]);
});

describe.each([
  ['POST /reviews', (r?: object) => post({ album_id: 9, ...r })],
  ['PATCH /reviews/:id', (r?: object) => patch({ review: 'x', ...r })],
  ['POST /reviews/:id/submit', () => submit()],
  ['DELETE /reviews/:id', () => remove()],
])('%s grant', (name, send) => {
  test.each(['dj', 'musicDirector', 'stationManager'])('%s is authorized', async (role) => {
    mockRole(role);
    expect((await send()).status).toBe(name.startsWith('DELETE') ? 204 : 200);
  });

  test.each(['member', undefined])('%s is refused before any query', async (role) => {
    mockRole(role);
    expect((await send()).status).toBe(403);
    for (const mock of [mockCreate, mockUpdate, mockSubmit, mockDelete]) expect(mock).not.toHaveBeenCalled();
  });
});

describe('GET /reviews and GET /reviews/:id (BS#2805)', () => {
  const get = (path: string) => request(app).get(path).set('Authorization', 'Bearer t');

  test.each(['dj', 'musicDirector', 'stationManager'])('%s may read', async (role) => {
    mockRole(role);
    expect((await get('/reviews')).status).toBe(200);
    expect((await get('/reviews/3')).body).toEqual(REVIEW);
  });

  test.each(['member', undefined])('%s is refused before any query', async (role) => {
    mockRole(role);
    expect((await get('/reviews')).status).toBe(403);
    expect((await get('/reviews/3')).status).toBe(403);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  test('a review the service will not show is a 404', async () => {
    mockRole('dj');
    mockGet.mockResolvedValue(undefined);
    expect((await get('/reviews/3')).status).toBe(404);
  });

  test('the filters reach the service parsed, and mine=false equals no mine', async () => {
    mockRole('dj');
    await get('/reviews?album_id=9&intake_item_id=4&mine=true');
    expect(mockList).toHaveBeenLastCalledWith(
      { album_id: 9, intake_item_id: 4, mine: true },
      { id: 'caller-id', manage: false }
    );
    await get('/reviews?mine=false');
    expect(mockList).toHaveBeenLastCalledWith(
      { album_id: undefined, intake_item_id: undefined, mine: false },
      expect.anything()
    );
  });

  test.each([
    '?album_id=0',
    '?album_id=2147483648',
    '?album_id=abc',
    '?album_id=1&album_id=2',
    '?intake_item_id=2147483648',
    '?intake_item_id=-1',
    '?mine=yes',
    '?mine=true&mine=true',
  ])('%s is a 400 before any query', async (query) => {
    mockRole('dj');
    expect((await get(`/reviews${query}`)).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  test.each([['abc'], ['0'], ['2147483648']])('id %s is a 400 before any query', async (id) => {
    mockRole('dj');
    expect((await get(`/reviews/${id}`)).status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('POST /reviews', () => {
  beforeEach(() => mockRole('dj'));

  test('answers 200 with the draft, and asks the service for the caller as a non-manager', async () => {
    const res = await post({
      intake_item_id: 4,
      review: '  great  ',
      buzzwords: '   ',
      publish_apps: true,
      credit: null,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(REVIEW);
    expect(mockCreate).toHaveBeenCalledWith(
      { intake_item_id: 4, album_id: undefined },
      { review: 'great', buzzwords: null, publish_apps: true, credit: null },
      { id: 'caller-id', manage: false }
    );
  });

  test.each([{}, { intake_item_id: 1, album_id: 2 }, { album_id: 0 }, { album_id: 2147483648 }, { album_id: '2' }])(
    'a bad subject %j is a 400',
    async (body) => {
      expect((await post(body)).status).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    }
  );

  test.each([{ publish_apps: 'yes' }, { credit: 'both' }, { review: 5 }])(
    'an invalid field %j is a 400',
    async (body) => {
      expect((await post({ album_id: 9, ...body })).status).toBe(400);
    }
  );

  test('subject_not_held is a 409 with the closed reason', async () => {
    mockCreate.mockResolvedValue({ outcome: 'subject_not_held' });
    const res = await post({ intake_item_id: 4 });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('subject_not_held');
  });

  test.each([
    ['dj', 403],
    ['musicDirector', 400],
  ] as const)('%s sending author is a %i (on-behalf is slice 13)', async (role, status) => {
    mockRole(role);
    expect((await post({ album_id: 9, author: 'Someone' })).status).toBe(status);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('PATCH /reviews/:id', () => {
  test('passes the id and the caller, with manage from the role', async () => {
    mockRole('musicDirector');
    await patch({ fcc: 'note' });
    expect(mockUpdate).toHaveBeenCalledWith(3, { fcc: 'note' }, { id: 'caller-id', manage: true });
  });

  test.each([
    ['not_found', 404],
    ['forbidden', 403],
    ['consent_forbidden', 403],
    ['text_required', 400],
  ])('%s is a %i', async (outcome, status) => {
    mockRole('dj');
    mockUpdate.mockResolvedValue({ outcome });
    expect((await patch({ review: null })).status).toBe(status);
  });

  test.each([
    { credit: 'dj_name' },
    { credit: null },
    { publish_website: true },
    { publish_apps: false },
    { publish_instagram: true },
  ])(
    "a music director's patch carrying consent %j reaches the service as a manager, and its consent_forbidden is a 403 naming the consent rule",
    async (body) => {
      mockRole('musicDirector');
      mockUpdate.mockResolvedValue({ outcome: 'consent_forbidden' });
      const res = await patch(body);
      expect([res.status, res.body.message]).toEqual([403, "Only the review's author may set its publishing choices"]);
      expect(mockUpdate).toHaveBeenCalledWith(3, body, { id: 'caller-id', manage: true });
    }
  );

  test('the plain forbidden keeps its own message, so a client can tell it from the consent refusal', async () => {
    mockRole('musicDirector');
    mockUpdate.mockResolvedValue({ outcome: 'forbidden' });
    const res = await patch({ credit: 'dj_name', review: 'late edit' });
    expect([res.status, res.body.message]).toEqual([403, 'You may not edit this review']);
  });

  test("a DJ's consent keys reach the service as a non-manager, and the service's updated review is the 200 body", async () => {
    mockRole('dj');
    const review = { id: 3, status: 'submitted', credit: 'real_name', publish_apps: true };
    mockUpdate.mockResolvedValue({ outcome: 'updated', review });
    const res = await patch({ credit: 'real_name', publish_apps: true });
    expect([res.status, res.body]).toEqual([200, review]);
    expect(mockUpdate).toHaveBeenCalledWith(
      3,
      { credit: 'real_name', publish_apps: true },
      { id: 'caller-id', manage: false }
    );
  });

  test.each([['abc'], ['0'], ['2147483648']])('id %s is a 400 naming the review, before any query', async (id) => {
    mockRole('dj');
    const res = await patch({ review: 'x' }, id);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid review id');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('an empty patch is a 400', async () => {
    mockRole('dj');
    expect((await patch({})).status).toBe(400);
  });
});

describe('POST /reviews/:id/submit', () => {
  test('passes the id and the caller, with manage from the role, and answers the service review', async () => {
    mockRole('musicDirector');
    const res = await submit();
    expect([res.status, res.body]).toEqual([200, REVIEW]);
    expect(mockSubmit).toHaveBeenCalledWith(3, { id: 'caller-id', manage: true });
  });

  test('sends the notice the service returned, and none when it returned none or the submit was refused', async () => {
    mockRole('dj');
    const notice = {
      itemId: 8,
      artist: 'Juana Molina',
      album: 'DOGA',
      author: 'Test Reviewer',
      line: { kind: 'pool' },
    };
    mockSubmit.mockResolvedValueOnce({ outcome: 'submitted', review: REVIEW, notice });
    await submit();
    expect(mockNotifySubmitted).toHaveBeenCalledTimes(1);
    expect(mockNotifySubmitted).toHaveBeenCalledWith(notice);
    await submit();
    mockSubmit.mockResolvedValueOnce({ outcome: 'not_draft' });
    await submit();
    expect(mockNotifySubmitted).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['not_found', 404],
    ['forbidden', 403],
    ['text_required', 400],
    ['not_draft', 409],
  ])('%s is a %i', async (outcome, status) => {
    mockRole('dj');
    mockSubmit.mockResolvedValue({ outcome });
    const res = await submit();
    expect(res.status).toBe(status);
    if (status === 409) expect(res.body.reason).toBe('not_draft');
  });

  test.each([['abc'], ['0'], ['2147483648']])('id %s is a 400 naming the review, before any query', async (id) => {
    mockRole('dj');
    const res = await submit(id);
    expect([res.status, res.body.message]).toEqual([400, 'Invalid review id']);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});

describe('DELETE /reviews/:id', () => {
  test('passes the id and the caller, and answers 204 with no body', async () => {
    mockRole('dj');
    const res = await remove();
    expect([res.status, res.text]).toEqual([204, '']);
    expect(mockDelete).toHaveBeenCalledWith(3, { id: 'caller-id', manage: false });
  });

  test.each([
    ['not_found', 404, undefined],
    ['forbidden', 403, undefined],
    ['in_use', 409, 'in_use'],
    ['accepted_review', 409, 'accepted_review'],
  ])('%s is a %i', async (outcome, status, reason) => {
    mockRole('dj');
    mockDelete.mockResolvedValue({ outcome });
    const res = await remove();
    expect(res.status).toBe(status);
    expect(res.body.reason).toBe(reason);
  });

  test("a DJ cannot delete someone else's review, and a music director can: the service is asked as each", async () => {
    mockRole('dj');
    mockDelete.mockResolvedValue({ outcome: 'forbidden' });
    expect((await remove()).status).toBe(403);
    mockRole('musicDirector');
    mockDelete.mockResolvedValue({ outcome: 'deleted' });
    expect((await remove()).status).toBe(204);
    expect(mockDelete.mock.calls.map((c) => c[1].manage)).toEqual([false, true]);
  });

  test.each([['abc'], ['0'], ['2147483648']])('id %s is a 400 before any query', async (id) => {
    mockRole('dj');
    expect((await remove(id)).status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });
});

describe('GET /reviews/:id/revisions (BS#2861)', () => {
  const get = (path: string) => request(app).get(path).set('Authorization', 'Bearer t');

  test.each(['dj', 'musicDirector', 'stationManager'])('%s may read', async (role) => {
    mockRole(role);
    const res = await get('/reviews/3/revisions');
    expect([res.status, res.body]).toEqual([200, []]);
    expect(mockRevisions).toHaveBeenLastCalledWith(3, { id: 'caller-id', manage: role !== 'dj' });
  });

  test.each(['member', undefined])('%s is refused before any query', async (role) => {
    mockRole(role);
    expect((await get('/reviews/3/revisions')).status).toBe(403);
    expect(mockRevisions).not.toHaveBeenCalled();
  });

  test('a review the service will not show is a 404, and a malformed id a 400', async () => {
    mockRole('dj');
    mockRevisions.mockResolvedValue(undefined);
    expect((await get('/reviews/3/revisions')).status).toBe(404);
    expect((await get('/reviews/abc/revisions')).status).toBe(400);
  });
});
