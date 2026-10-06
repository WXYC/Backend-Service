// Same real-middleware harness as intake-transitions.route.test.ts (the shared
// `@wxyc/authentication` stub ignores the permission argument).
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
const mockRole = (role?: string) =>
  mockedJwtVerify.mockResolvedValue({
    payload: { sub: 'caller-id', email: 'test@wxyc.org', ...(role === undefined ? {} : { role }) },
    protectedHeader: { alg: 'RS256' },
    key: {} as any,
  });

const mockAcceptReview = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();

jest.mock('@wxyc/database', () => ({
  intakeItemStateEnum: jest.requireActual('../../../shared/database/src/schema').intakeItemStateEnum,
}));
jest.mock('../../../apps/backend/services/intake.service', () => ({ acceptReview: mockAcceptReview }));

// The controller imports the filing seam (BS#2803), whose service module reads real schema tables at load.
jest.mock('../../../apps/backend/services/library-filing.service', () => ({}));

import { intake_route } from '../../../apps/backend/routes/intake.route';
import errorHandler from '../../../apps/backend/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/intake', intake_route);
app.use(errorHandler);

const ITEM = { id: 7, state: 'reviewed', effective_state: 'reviewed', accepted_review_id: 3 };
const accept = (body?: object, id: string | number = 7) =>
  request(app)
    .post(`/intake/${id}/accept-review`)
    .set('Authorization', 'Bearer t')
    .send(body ?? {});

beforeEach(() => {
  mockedJwtVerify.mockReset();
  mockAcceptReview.mockReset().mockResolvedValue({ outcome: 'accepted', item: ITEM });
});

describe('POST /intake/:id/accept-review (BS#2860)', () => {
  test.each(['musicDirector', 'stationManager'])(
    '%s is allowed and the service is asked to accept for the caller',
    async (role) => {
      mockRole(role);
      const res = await accept({ review_id: 3 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual(ITEM);
      expect(mockAcceptReview).toHaveBeenCalledWith(7, 3, { id: 'caller-id', manage: true });
    }
  );

  test.each(['member', 'dj', undefined])('%s is refused with 403 before any query', async (role) => {
    mockRole(role);
    expect((await accept({ review_id: 3 })).status).toBe(403);
    expect(mockAcceptReview).not.toHaveBeenCalled();
  });

  test('a missing review_id is a 400 with its own message', async () => {
    mockRole('musicDirector');
    const res = await accept({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('review_id is required');
    expect(mockAcceptReview).not.toHaveBeenCalled();
  });

  test.each([['3'], [0], [-1], [1.5], [2147483648], [null]])(
    'a malformed review_id %j is a 400 before any query',
    async (review_id) => {
      mockRole('musicDirector');
      const res = await accept({ review_id });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/^review_id must be a positive integer/);
      expect(mockAcceptReview).not.toHaveBeenCalled();
    }
  );

  test("a review that is missing, a draft or another record's answers one 400 message", async () => {
    mockRole('musicDirector');
    mockAcceptReview.mockResolvedValue({ outcome: 'bad_review' });
    const res = await accept({ review_id: 3 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('review_id must name a submitted review of this record');
  });

  test('a missing item is a 404', async () => {
    mockRole('musicDirector');
    mockAcceptReview.mockResolvedValue({ outcome: 'not_found' });
    expect((await accept({ review_id: 3 })).status).toBe(404);
  });

  test('an id past int4 is a 400 before any query', async () => {
    mockRole('musicDirector');
    expect((await accept({ review_id: 3 }, 2147483648)).status).toBe(400);
    expect(mockAcceptReview).not.toHaveBeenCalled();
  });
});
