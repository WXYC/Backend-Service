// Set required env vars before module load (ts-jest transforms imports to
// requires, so these execute before the auth middleware module's top-level
// code runs). Mirrors tests/unit/routes/flowsheet-operator-close-permissions.route.test.ts.
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';
delete process.env.AUTH_BYPASS;

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));

// jest.unit.config.ts's moduleNameMapper sends `@wxyc/authentication` to a stub
// whose requirePermissions only checks for an Authorization header, ignoring
// the permission argument entirely. This suite is about the permission
// argument, so the REAL implementation is wired back in.
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

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  ...jest
    .requireActual<typeof import('../../mocks/flowsheet-service.mock')>('../../mocks/flowsheet-service.mock')
    .createFlowsheetServiceMock(),
  getLastModifiedAt: jest.fn(),
}));

import { resetFlowsheetServiceMock } from '../../mocks/flowsheet-service.mock';
import * as flowsheetService from '../../../apps/backend/services/flowsheet.service';
import { flowsheet_route } from '../../../apps/backend/routes/flowsheet.route';

const service = flowsheetService as unknown as ReturnType<
  typeof import('../../mocks/flowsheet-service.mock').createFlowsheetServiceMock
>;
const { getRecentShows: mockGetRecentShows } = service;

const app = express();
app.use(express.json());
app.use('/flowsheet', flowsheet_route);

/**
 * BS#2435. `GET /flowsheet/shows/recent` is gated to `flowsheet: ['read']` —
 * every signed-in station account, deliberately NOT the `flowsheet: ['manage']`
 * tier its neighbour `GET /flowsheet/open-shows` carries. Nothing here is
 * destructive, and the content is a list of who was on the radio, which is
 * public by the time it airs.
 *
 * It is still gated, though: `GET /flowsheet/range` is the router's only
 * genuinely unauthenticated read (`security: []`), and this is not it. That is
 * the assertion the no-header case pins.
 *
 * Integration tests run under AUTH_BYPASS=true, whose branch short-circuits to
 * next() before any permission check, so they cannot cover this tier.
 */
describe('recent shows — permission tier (BS#2435)', () => {
  beforeEach(() => {
    resetFlowsheetServiceMock(service, new Date('2026-09-15T00:00:00.000Z'));
  });

  const call = () => request(app).get('/flowsheet/shows/recent');

  // Every station role holds `flowsheet: ['read']`, including `member` — the
  // one role the `manage`-gated neighbour excludes outright.
  test.each(['member', 'dj', 'musicDirector', 'stationManager'])('a %s token is authorized', async (role) => {
    mockRole(role);
    const res = await call().set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(200);
  });

  test('a request with no Authorization header is rejected with 401', async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(mockGetRecentShows).not.toHaveBeenCalled();
  });
});
