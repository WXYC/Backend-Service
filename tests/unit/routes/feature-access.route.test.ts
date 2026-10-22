// Real requirePermissions with a mocked jose, as album-reviews-permissions.route.test.ts does: the stub in
// tests/mocks/authentication.mock.ts never sets req.auth, and the role is read from the verified token.
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';
delete process.env.AUTH_BYPASS;

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));
// The seam's `roleToAuthorization` lives in auth.roles, beside the middleware's export.
jest.mock('@wxyc/authentication', () => ({
  ...jest.requireActual('../../../shared/authentication/src/auth.roles'),
  ...jest.requireActual('../../../shared/authentication/src/auth.middleware'),
}));

import { db } from '@wxyc/database';
import express from 'express';
import { jwtVerify } from 'jose';
import request from 'supertest';
import type { Audience } from '../../../apps/backend/config/featureAccess';
import type { FeatureAudience } from '@wxyc/shared/dtos';
import { feature_access_route } from '../../../apps/backend/routes/feature-access.route';
import { ACCESS_CASES, givenAudience, restoreAudience } from '../../utils/feature-access';
import type { Equal } from '../../utils/type-equal';

const mockedJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;
const mockLimit = jest.fn();
(db.select() as unknown as Record<string, jest.Mock>).limit = mockLimit;

const app = express();
app.use(express.json());
app.use('/feature-access', feature_access_route);

/** The token as minted: `claimed` is the capabilities claim, which the route must not read. */
const signIn = (role: string | undefined, claimed: string[] = []) =>
  mockedJwtVerify.mockResolvedValue({
    payload: { sub: 'test-user-id', email: 'test@wxyc.org', capabilities: claimed, ...(role ? { role } : {}) },
    protectedHeader: { alg: 'RS256' },
    key: {} as never,
  });
const get = () => request(app).get('/feature-access').set('Authorization', 'Bearer test-token');

beforeEach(() => {
  jest.clearAllMocks();
  givenAudience(undefined);
  mockLimit.mockResolvedValue([{ capabilities: [] }]);
});

afterAll(restoreAudience);

describe('GET /feature-access', () => {
  it.each(ACCESS_CASES)(
    'at audience %s, role %s, capabilities %j answers can_see %s',
    async (audience, role, capabilities, canSee) => {
      givenAudience(audience);
      signIn(role);
      mockLimit.mockResolvedValue([{ capabilities }]);

      const response = await get();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ reviews: { audience, can_see: canSee } });
    }
  );

  it('reads capabilities from the column, so a grant made after the token was minted shows at once', async () => {
    givenAudience('staff');
    signIn('dj', []);
    expect((await get()).body.reviews.can_see).toBe(false);

    mockLimit.mockResolvedValue([{ capabilities: ['reviews_beta'] }]);
    expect((await get()).body.reviews.can_see).toBe(true);
  });

  it('ignores a capability the token claims but the column no longer holds', async () => {
    givenAudience('staff');
    signIn('dj', ['reviews_beta']);
    expect((await get()).body.reviews.can_see).toBe(false);
  });

  it('answers can_see false for an anonymous session, which carries no role', async () => {
    givenAudience('everyone');
    signIn(undefined);
    expect((await get()).body).toEqual({ reviews: { audience: 'everyone', can_see: false } });
  });

  it('treats an account with no auth_user row as holding no capabilities', async () => {
    givenAudience('staff');
    signIn('dj');
    mockLimit.mockResolvedValue([]);
    expect((await get()).body.reviews.can_see).toBe(false);
  });

  it('reads the account once per request, by primary key', async () => {
    signIn('dj');
    await get();
    expect(mockLimit).toHaveBeenCalledTimes(1);
  });

  it('is not cached by a browser or a shared cache', async () => {
    signIn('dj');
    expect((await get()).headers['cache-control']).toBe('private, no-store');
  });

  it('requires a bearer token', async () => {
    const response = await request(app).get('/feature-access');
    expect(response.status).toBe(401);
    expect(mockLimit).not.toHaveBeenCalled();
  });
});

/** Compile-time pin: the registry's `Audience` is the contract's `FeatureAudience`. */
const audiencePin: Equal<Audience, FeatureAudience> = true;

it("uses the contract's FeatureAudience as the registry Audience", () => {
  expect(audiencePin).toBe(true);
});
