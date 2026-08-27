// Set required env vars before module load (ts-jest transforms imports to
// requires, so these execute before the auth middleware module's top-level
// code runs). Mirrors tests/unit/routes/library-genres-permissions.route.test.ts.
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';
delete process.env.AUTH_BYPASS;

// Mock jose so we can hand back an arbitrary role in the verified JWT payload
// without a real JWKS endpoint. requirePermissions's non-bypass branch is what
// actually enforces role/permission checks. Note: integration tests run with
// AUTH_BYPASS=true, whose branch short-circuits to next() before any permission
// check runs, so they cannot exercise this route's auth tier -- hence this
// real-middleware unit test.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));

// jest.unit.config.ts's moduleNameMapper sends `@wxyc/authentication` to
// tests/mocks/authentication.mock.ts (a stub whose requirePermissions only
// checks for an Authorization header, ignoring the role/permission argument
// entirely). album-reviews.route.ts imports requirePermissions from that
// package specifier, so this route-wiring test needs the REAL implementation
// wired back in to actually exercise the album_reviews:read gate. Extending the
// shared mock instead would change behavior for every unit test in the repo,
// which its own docblock warns against.
jest.mock('@wxyc/authentication', () => jest.requireActual('../../../shared/authentication/src/auth.middleware'));

import { jest as jestGlobals } from '@jest/globals';
import { jwtVerify } from 'jose';
import express from 'express';
import request from 'supertest';

const mockedJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;

function mockRole(role?: string) {
  mockedJwtVerify.mockResolvedValue({
    payload: { sub: 'test-user-id', email: 'test@wxyc.org', ...(role === undefined ? {} : { role }) },
    protectedHeader: { alg: 'RS256' },
    key: {} as any,
  });
}

const mockGetAlbumReviewsPage = jestGlobals.fn<() => Promise<unknown[]>>();
const mockGetAlbumReviewsCount = jestGlobals.fn<() => Promise<number>>();

jest.mock('../../../apps/backend/services/album-reviews.service', () => ({
  getAlbumReviewsPage: mockGetAlbumReviewsPage,
  getAlbumReviewsCount: mockGetAlbumReviewsCount,
}));

import { album_reviews_route } from '../../../apps/backend/routes/album-reviews.route';

const app = express();
app.use(express.json());
app.use('/album-reviews', album_reviews_route);

/**
 * `GET /album-reviews` (ADR 0011) is the INTERNAL DJ-review surface: it serves
 * the whole form archive with no `social_consent` filter, including the 32 rows
 * whose reviewer declined social-media publication and the 999 written before
 * the consent question existed. The public per-album `wxycReviews` attach on
 * `GET /proxy/metadata/album` keeps its hard `social_consent = true` gate.
 *
 * The whole safety argument for the unfiltered surface is that only signed-in
 * station members reach it, so these cases are the load-bearing test in CI:
 * `npm run ci:testmock` cannot substitute for them. Its `jest.config.json`
 * testMatch is integration-only (unit tests never run under it) AND its
 * containers set AUTH_BYPASS=true, under which requirePermissions returns
 * next() before the permission block is reached. A green integration run proves
 * nothing about this gate.
 *
 * `stationManager` is asserted alongside `dj` deliberately, even though the
 * grant matrix in auth.roles.ts now makes omitting it a compile error rather
 * than a runtime 403. `requirePermissions` is a pure per-role check with no
 * hierarchy, so "the top role is covered because it is the top role" is not a
 * property this route can rely on; the matrix enforces the grant, and this
 * asserts the HTTP consequence of it. Two independent guards for the inversion
 * class where a plain DJ gets 200 while the most privileged account 403s.
 */
describe('GET /album-reviews — album_reviews:read gate (ADR 0011 internal surface)', () => {
  beforeEach(() => {
    mockedJwtVerify.mockReset();
    mockGetAlbumReviewsPage.mockReset().mockResolvedValue([]);
    mockGetAlbumReviewsCount.mockReset().mockResolvedValue(0);
  });

  test.each(['dj', 'musicDirector', 'stationManager'] as const)('a %s-role token is authorized', async (role) => {
    mockRole(role);
    const res = await request(app).get('/album-reviews').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(mockGetAlbumReviewsPage).toHaveBeenCalled();
    // Mounting assertion, folded in from the plain route test this file
    // replaced: the router reaches the controller and the controller's
    // envelope comes back, so a 200 here is a served request rather than a
    // middleware that fell through to an empty handler.
    expect(res.body).toEqual({ album_reviews: [], pagination: { page: 1, limit: 50, total: 0, hasMore: false } });
  });

  test('a member-role token is rejected with 403', async () => {
    mockRole('member');
    const res = await request(app).get('/album-reviews').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(403);
    expect(mockGetAlbumReviewsPage).not.toHaveBeenCalled();
  });

  test('an anonymous session (verified JWT, no role claim) is rejected with 403', async () => {
    // Anonymous sessions carry no membership, so buildJwtPayload leaves `role`
    // unset. This is the assertion that keeps the listener app — which mints
    // anonymous JWTs from 18 call sites — out of the non-consented archive.
    mockRole(undefined);
    const res = await request(app).get('/album-reviews').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(403);
    expect(mockGetAlbumReviewsPage).not.toHaveBeenCalled();
  });

  test('a request with no Authorization header is rejected with 401', async () => {
    const res = await request(app).get('/album-reviews');
    expect(res.status).toBe(401);
    expect(mockGetAlbumReviewsPage).not.toHaveBeenCalled();
  });
});
