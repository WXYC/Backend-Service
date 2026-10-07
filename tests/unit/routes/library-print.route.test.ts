// Same real-middleware harness as intake-print-finalize.route.test.ts (the shared `@wxyc/authentication` stub ignores the permission argument).
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
import { WXYCRoles } from '../../../shared/authentication/src/auth.roles';

const mockedJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;
const mockRole = (role?: string) =>
  mockedJwtVerify.mockResolvedValue({
    payload: { sub: 'caller-id', email: 'test@wxyc.org', ...(role === undefined ? {} : { role }) },
    protectedHeader: { alg: 'RS256' },
    key: {} as any,
  });

const mockPrintReleaseReview = jestGlobals.fn<(...args: any[]) => Promise<any>>();

jest.mock('@wxyc/database', () => ({
  intakeItemStateEnum: jest.requireActual('../../../shared/database/src/schema').intakeItemStateEnum,
}));
jest.mock('../../../apps/backend/services/review-print.service', () => ({
  printReleaseReview: mockPrintReleaseReview,
}));
jest.mock('../../../apps/backend/services/library.service', () => ({}));
jest.mock('../../../apps/backend/services/library-filing.service', () => ({}));
jest.mock('../../../apps/backend/services/labels.service', () => ({}));
jest.mock('../../../apps/backend/services/library-search.service', () => ({}));
jest.mock('@wxyc/lml-client', () => ({ envInt: (_name: string, fallback: number) => fallback }));
jest.mock('../../../apps/backend/services/lml/lookup-coordinator', () => ({ lmlLookupCoordinator: {} }));
jest.mock('../../../apps/backend/controllers/requestLine.controller', () => ({ searchLibraryEndpoint: jest.fn() }));

import { library_route } from '../../../apps/backend/routes/library.route';
import errorHandler from '../../../apps/backend/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/library', library_route);
app.use(errorHandler);

const SLIP = { artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again', revision_id: 55, fcc_notes: [] };
const call = (id: string | number = 12, body: unknown = { review_id: 3 }) =>
  request(app)
    .post(`/library/${id}/print`)
    .set('Authorization', 'Bearer t')
    .send(body as object);

beforeEach(() => {
  mockedJwtVerify.mockReset();
  mockPrintReleaseReview.mockReset().mockResolvedValue({ outcome: 'printed', slip: SLIP });
});

describe('POST /library/:id/print (BS#2865)', () => {
  it('admits a music director and refuses member, dj and no role with 403 before any query', async () => {
    mockRole('musicDirector');
    expect((await call()).status).toBe(200);
    mockPrintReleaseReview.mockClear();
    for (const role of ['member', 'dj', undefined]) {
      mockRole(role);
      expect((await call()).status).toBe(403);
    }
    expect(mockPrintReleaseReview).not.toHaveBeenCalled();
  });

  // `reviews: manage` and `catalog: write` select the same roles today, so withhold one grant from a music director to see which the route asks for.
  it.each([
    ['reviews', 403],
    ['catalog', 200],
  ] as const)('with `%s` withheld from a music director answers %i', async (withheld, status) => {
    mockRole('musicDirector');
    const authorize = WXYCRoles.musicDirector.authorize as (statement: Record<string, string[]>) => {
      success: boolean;
    };
    const original = authorize.bind(WXYCRoles.musicDirector);
    jest
      .spyOn(WXYCRoles.musicDirector as { authorize: typeof authorize }, 'authorize')
      .mockImplementation((statement) => (withheld in statement ? { success: false } : original(statement)));
    expect((await call()).status).toBe(status);
    jest.restoreAllMocks();
  });

  it('answers 401 without a token', async () => {
    expect((await request(app).post('/library/12/print').send({ review_id: 3 })).status).toBe(401);
  });

  it('returns the slip and passes the release, the review and the caller to the service', async () => {
    mockRole('musicDirector');
    const res = await call();
    expect(res.body).toEqual(SLIP);
    expect(mockPrintReleaseReview).toHaveBeenCalledWith(12, 3, expect.objectContaining({ id: 'caller-id' }));
  });

  it.each([
    ['a malformed path id', 'abc', { review_id: 3 }],
    ['a missing review_id', 12, {}],
    ['a malformed review_id', 12, { review_id: 'x' }],
  ])('%s is 400 and prints nothing', async (_name, id, body) => {
    mockRole('musicDirector');
    expect((await call(id, body)).status).toBe(400);
    expect(mockPrintReleaseReview).not.toHaveBeenCalled();
  });

  it.each([
    ['not_found', 404],
    ['bad_review', 400],
  ])('maps the %s outcome to %s', async (outcome, status) => {
    mockRole('musicDirector');
    mockPrintReleaseReview.mockResolvedValue({ outcome });
    expect((await call()).status).toBe(status);
  });
});
