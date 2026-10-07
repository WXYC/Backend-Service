/**
 * Permission tier and body handling for GET / PATCH /library/rotation/thresholds.
 * Runs the real requirePermissions middleware; integration tests run with
 * AUTH_BYPASS and cannot see a 401 or 403.
 */
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';
delete process.env.AUTH_BYPASS;

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));

jest.mock('@wxyc/authentication', () => jest.requireActual('../../../shared/authentication/src/auth.middleware'));

import { jest as jestGlobals } from '@jest/globals';
import { jwtVerify } from 'jose';
import express from 'express';
import request from 'supertest';

const mockedJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;

function mockRole(role: string) {
  mockedJwtVerify.mockResolvedValue({
    payload: { sub: 'test-user-id', email: 'test@wxyc.org', role },
    protectedHeader: { alg: 'RS256' },
    key: {} as any,
  });
}

type Thresholds = { window_days: Record<'H' | 'M' | 'L' | 'S', number>; card_stale_days: number };
const mockGetRotationThresholds = jestGlobals.fn<() => Promise<Thresholds>>();
const mockUpdateRotationThresholds = jestGlobals.fn<(patch: unknown) => Promise<Thresholds>>();

jest.mock('../../../apps/backend/services/rotation-thresholds.service', () => ({
  getRotationThresholds: mockGetRotationThresholds,
  updateRotationThresholds: mockUpdateRotationThresholds,
}));

jest.mock('../../../apps/backend/services/library.service', () =>
  jest
    .requireActual<typeof import('../../mocks/library-service-rotation.mock')>(
      '../../mocks/library-service-rotation.mock'
    )
    .createLibraryServiceRotationMock()
);

jest.mock('../../../apps/backend/services/labels.service', () => ({}));
jest.mock('../../../apps/backend/services/library-search.service', () => ({
  parseEnumQueryList: () => undefined,
  parseRotationBinsQueryList: () => undefined,
}));
jest.mock('@wxyc/lml-client', () => ({
  checkStreamingAvailability: jest.fn(),
  lookupMetadata: jest.fn(),
  isLmlConfigured: () => false,
  envInt: (_name: string, fallback: number) => fallback,
}));
jest.mock('../../../apps/backend/services/lml/lookup-coordinator', () => ({
  lmlLookupCoordinator: { lookup: jest.fn() },
}));
jest.mock('../../../apps/backend/controllers/requestLine.controller', () => ({ searchLibraryEndpoint: jest.fn() }));

import { library_route } from '../../../apps/backend/routes/library.route';
import errorHandler from '../../../apps/backend/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/library', library_route);
app.use(errorHandler);

const current: Thresholds = { window_days: { H: 60, M: 60, L: 60, S: 60 }, card_stale_days: 30 };

beforeEach(() => {
  mockGetRotationThresholds.mockReset().mockResolvedValue(current);
  mockUpdateRotationThresholds.mockReset().mockResolvedValue(current);
});

describe('GET /library/rotation/thresholds', () => {
  test('a dj-role token (catalog:read) gets the whole record', async () => {
    mockRole('dj');
    const res = await request(app).get('/library/rotation/thresholds').set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(current);
  });

  test('a request with no Authorization header is rejected', async () => {
    const res = await request(app).get('/library/rotation/thresholds');

    expect(res.status).toBe(401);
    expect(mockGetRotationThresholds).not.toHaveBeenCalled();
  });

  test('a token whose role maps to no grants is rejected', async () => {
    mockRole('user');
    const res = await request(app).get('/library/rotation/thresholds').set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(403);
    expect(mockGetRotationThresholds).not.toHaveBeenCalled();
  });
});

describe('PATCH /library/rotation/thresholds', () => {
  test('a musicDirector-role token (catalog:write) applies a partial patch and gets the whole record back', async () => {
    mockRole('musicDirector');
    const after = { ...current, window_days: { ...current.window_days, H: 30 } };
    mockUpdateRotationThresholds.mockResolvedValue(after);

    const res = await request(app)
      .patch('/library/rotation/thresholds')
      .set('Authorization', 'Bearer test-token')
      .send({ window_days: { H: 30 } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(after);
    expect(mockUpdateRotationThresholds).toHaveBeenCalledWith({ window_days: { H: 30 } });
  });

  test('an empty body is a 200 no-op that still answers the current record', async () => {
    mockRole('musicDirector');
    const res = await request(app)
      .patch('/library/rotation/thresholds')
      .set('Authorization', 'Bearer test-token')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual(current);
    expect(mockUpdateRotationThresholds).toHaveBeenCalledWith({});
  });

  test('an invalid body is a 400 that names the key and never reaches the service', async () => {
    mockRole('musicDirector');
    const res = await request(app)
      .patch('/library/rotation/thresholds')
      .set('Authorization', 'Bearer test-token')
      .send({ window_days: { X: 30 } });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('X');
    expect(mockUpdateRotationThresholds).not.toHaveBeenCalled();
  });

  test('a dj-role token (catalog:read only) is rejected', async () => {
    mockRole('dj');
    const res = await request(app)
      .patch('/library/rotation/thresholds')
      .set('Authorization', 'Bearer test-token')
      .send({ card_stale_days: 14 });

    expect(res.status).toBe(403);
    expect(mockUpdateRotationThresholds).not.toHaveBeenCalled();
  });

  test('a request with no Authorization header is rejected', async () => {
    const res = await request(app).patch('/library/rotation/thresholds').send({ card_stale_days: 14 });

    expect(res.status).toBe(401);
    expect(mockUpdateRotationThresholds).not.toHaveBeenCalled();
  });
});
