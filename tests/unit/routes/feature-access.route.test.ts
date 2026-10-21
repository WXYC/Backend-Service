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
import { resetFeatureAccess } from '../../../apps/backend/config/featureAccess';
import type { FeatureKey } from '../../../apps/backend/config/featureAccess';
import type {
  FeatureAccessEntry,
  FeatureAccessResponse,
  FeatureAudience,
} from '../../../apps/backend/controllers/feature-access.controller';
import { feature_access_route } from '../../../apps/backend/routes/feature-access.route';

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

const ENV_AUDIENCE = { off: undefined, staff: 'staff', everyone: 'true' } as const;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.POSTHOG_FLAGS_API_KEY;
  delete process.env.POSTHOG_SECRET_KEY;
  delete process.env.REVIEWS_AUDIENCE;
  resetFeatureAccess();
  mockLimit.mockResolvedValue([{ capabilities: [] }]);
});

describe('GET /feature-access', () => {
  const cases = (['off', 'staff', 'everyone'] as const).flatMap((audience) =>
    (['member', 'dj', 'musicDirector', 'stationManager'] as const).flatMap((role) =>
      ([[], ['reviews_beta']] as string[][]).map((capabilities) => {
        const staffLevel = role === 'musicDirector' || role === 'stationManager';
        const djLevel = staffLevel || role === 'dj';
        const canSee =
          audience === 'everyone'
            ? djLevel
            : audience === 'staff' && djLevel && (staffLevel || capabilities.length > 0);
        return [audience, role, capabilities, canSee] as const;
      })
    )
  );

  it.each(cases)(
    'at audience %s, role %s, capabilities %j answers can_see %s',
    async (audience, role, capabilities, canSee) => {
      if (ENV_AUDIENCE[audience]) {
        process.env.REVIEWS_AUDIENCE = ENV_AUDIENCE[audience];
      }
      signIn(role);
      mockLimit.mockResolvedValue([{ capabilities }]);

      const response = await get();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ reviews: { audience, can_see: canSee } });
    }
  );

  it('reads capabilities from the column, so a grant made after the token was minted shows at once', async () => {
    process.env.REVIEWS_AUDIENCE = 'staff';
    signIn('dj', []);
    expect((await get()).body.reviews.can_see).toBe(false);

    mockLimit.mockResolvedValue([{ capabilities: ['reviews_beta'] }]);
    expect((await get()).body.reviews.can_see).toBe(true);
  });

  it('ignores a capability the token claims but the column no longer holds', async () => {
    process.env.REVIEWS_AUDIENCE = 'staff';
    signIn('dj', ['reviews_beta']);
    expect((await get()).body.reviews.can_see).toBe(false);
  });

  it('answers can_see false for an anonymous session, which carries no role', async () => {
    process.env.REVIEWS_AUDIENCE = 'true';
    signIn(undefined);
    expect((await get()).body).toEqual({ reviews: { audience: 'everyone', can_see: false } });
  });

  it('treats an account with no auth_user row as holding no capabilities', async () => {
    process.env.REVIEWS_AUDIENCE = 'staff';
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

/**
 * Compile-time pin: the mirrors must match the SSOT schemas in `wxyc-shared/api.yaml` (wxyc-shared#731, `FeatureAudience`,
 * `FeatureAccessEntry`, `FeatureAccessResponse`), which `@wxyc/shared` 5.4.0 does not export. When it does, import them
 * and keep these assertions. `FeatureAccessEntry` is closed at exactly these two keys, and `reviews` is required.
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type ApiYamlFeatureAudience = 'off' | 'staff' | 'everyone';
type ApiYamlFeatureAccessEntry = { audience: ApiYamlFeatureAudience; can_see: boolean };
type ApiYamlFeatureAccessResponse = { reviews: ApiYamlFeatureAccessEntry };
const audiencePin: Equal<FeatureAudience, ApiYamlFeatureAudience> = true;
const entryPin: Equal<FeatureAccessEntry, ApiYamlFeatureAccessEntry> = true;
const responsePin: Equal<FeatureAccessResponse, ApiYamlFeatureAccessResponse> = true;
const everyKeyIsAProperty: FeatureKey extends keyof ApiYamlFeatureAccessResponse ? true : false = true;

it('mirrors the contract schemas', () => {
  expect([audiencePin, entryPin, responsePin, everyKeyIsAProperty]).toEqual([true, true, true, true]);
});
