// Set required env vars before module load (ts-jest transforms imports to
// requires, so these execute before the auth middleware module's top-level
// code runs). Mirrors tests/unit/routes/album-reviews-permissions.route.test.ts.
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
// entirely). digital-archive.route.ts imports requirePermissions from that
// package specifier, so this route-wiring test needs the REAL implementation
// wired back in to actually exercise the digital_archive:listen gate.
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

const mockGetPlaybackManifest = jestGlobals.fn<() => Promise<unknown>>();

jest.mock('../../../apps/backend/services/digital-archive.service', () => ({
  getPlaybackManifest: mockGetPlaybackManifest,
}));

jest.mock('../../../apps/backend/config/digitalArchive', () => ({
  getConfig: () => ({ enabled: true, signTTLSeconds: 14400 }),
}));

import { digital_archive_route } from '../../../apps/backend/routes/digital-archive.route';

const app = express();
app.use(express.json());
app.use('/digital-archive', digital_archive_route);

/**
 * `GET /digital-archive/albums/:id/playback` (BS#2320) opens at `dj`+, the
 * same tier as `/album-reviews`: `member` is the pre-DJ tier and the legal
 * boundary is "authenticated DJs" over the auto-DJ Space. See
 * `auth.roles.ts`'s `digital_archive` key and
 * `tests/unit/routes/album-reviews-permissions.route.test.ts`, whose
 * structure this mirrors.
 */
describe('GET /digital-archive/albums/:id/playback — digital_archive:listen gate', () => {
  beforeEach(() => {
    mockedJwtVerify.mockReset();
    mockGetPlaybackManifest.mockReset().mockResolvedValue({
      library_id: 42,
      expires_at: '2026-01-01T00:00:00.000Z',
      tracks: [{ file_id: 1, provenance: 'rotation_upload', title: 'Track', renditions: [] }],
    });
  });

  test.each(['dj', 'musicDirector', 'stationManager'] as const)('a %s-role token is authorized', async (role) => {
    mockRole(role);
    const res = await request(app).get('/digital-archive/albums/42/playback').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
    expect(mockGetPlaybackManifest).toHaveBeenCalledWith(42);
  });

  test('a member-role token is rejected with 403', async () => {
    mockRole('member');
    const res = await request(app).get('/digital-archive/albums/42/playback').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(403);
    expect(mockGetPlaybackManifest).not.toHaveBeenCalled();
  });

  test('an anonymous session (verified JWT, no role claim) is rejected with 403', async () => {
    mockRole(undefined);
    const res = await request(app).get('/digital-archive/albums/42/playback').set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(403);
    expect(mockGetPlaybackManifest).not.toHaveBeenCalled();
  });

  test('a request with no Authorization header is rejected with 401', async () => {
    const res = await request(app).get('/digital-archive/albums/42/playback');
    expect(res.status).toBe(401);
    expect(mockGetPlaybackManifest).not.toHaveBeenCalled();
  });
});
