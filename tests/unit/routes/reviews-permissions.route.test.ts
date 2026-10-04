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

jest.mock('@wxyc/database', () => ({
  reviewCreditEnum: jest.requireActual('../../../shared/database/src/schema').reviewCreditEnum,
}));
jest.mock('../../../apps/backend/services/reviews.service', () => ({
  createReview: mockCreate,
  updateReview: mockUpdate,
}));

import { reviews_route } from '../../../apps/backend/routes/reviews.route';
import errorHandler from '../../../apps/backend/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/reviews', reviews_route);
app.use(errorHandler);

const REVIEW = { id: 3, status: 'draft', locked: false };
const post = (body: object) => request(app).post('/reviews').set('Authorization', 'Bearer t').send(body);
const patch = (body: object, id = '3') =>
  request(app).patch(`/reviews/${id}`).set('Authorization', 'Bearer t').send(body);

beforeEach(() => {
  mockedJwtVerify.mockReset();
  mockCreate.mockReset().mockResolvedValue({ outcome: 'created', review: REVIEW });
  mockUpdate.mockReset().mockResolvedValue({ outcome: 'updated', review: REVIEW });
});

describe.each([
  ['POST /reviews', (r?: object) => post({ album_id: 9, ...r })],
  ['PATCH /reviews/:id', (r?: object) => patch({ review: 'x', ...r })],
])('%s grant', (_name, send) => {
  test.each(['dj', 'musicDirector', 'stationManager'])('%s is authorized', async (role) => {
    mockRole(role);
    expect((await send()).status).toBe(200);
  });

  test.each(['member', undefined])('%s is refused before any query', async (role) => {
    mockRole(role);
    expect((await send()).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
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
    ['text_required', 400],
  ])('%s is a %i', async (outcome, status) => {
    mockRole('dj');
    mockUpdate.mockResolvedValue({ outcome });
    expect((await patch({ review: null })).status).toBe(status);
  });

  test('locked is a 409 with the closed reason', async () => {
    mockRole('dj');
    mockUpdate.mockResolvedValue({ outcome: 'locked' });
    const res = await patch({ review: 'late edit' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('locked');
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
