// Set required env vars before module load (ts-jest transforms imports to
// requires, so these execute before the auth middleware module's top-level
// code runs). Mirrors tests/unit/routes/library-missing-found-permissions.route.test.ts.
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

// The mirror middleware is registered on the force-end route; it taps the
// response and defers everything else to `res.once('finish')`. Stubbed to a
// pass-through so this suite tests the gate, not the tubafrenzy path.
jest.mock('../../../apps/backend/middleware/legacy/flowsheet.mirror', () => ({
  flowsheetMirror: new Proxy(
    {},
    {
      get: () => (_req: unknown, _res: unknown, next: () => void) => next(),
    }
  ),
}));

import { resetFlowsheetServiceMock } from '../../mocks/flowsheet-service.mock';
import * as flowsheetService from '../../../apps/backend/services/flowsheet.service';
import { flowsheet_route } from '../../../apps/backend/routes/flowsheet.route';

const service = flowsheetService as unknown as ReturnType<
  typeof import('../../mocks/flowsheet-service.mock').createFlowsheetServiceMock
>;
const { getOpenShows: mockGetOpenShows, getShowById: mockGetShowById, endShow: mockEndShow } = service;

const app = express();
app.use(express.json());
app.use('/flowsheet', flowsheet_route);

/**
 * BS#2235. The operator-close pair is the only surface in this router gated
 * above `flowsheet: ['write']` — every DJ holds that, and the whole point of
 * these two routes is to act on a show the caller does not own.
 *
 * `flowsheet: ['manage']` is held by musicDirector and stationManager only
 * (shared/authentication/src/auth.roles.ts). Note that the capability this
 * replaces — tubafrenzy's `EndShowServlet`, reachable from the signon page's
 * "Resume a Show" list — had NO ownership or role check at all, so this is a
 * narrowing, not a new grant.
 *
 * Integration tests run under AUTH_BYPASS=true, whose branch short-circuits to
 * next() before any permission check, so they cannot cover this tier.
 */
describe('operator close — permission tier (BS#2235)', () => {
  beforeEach(() => {
    // The permission tier is what this suite is about; the baseline keeps the
    // force-end confirmation guard quiet so a 403 can only come from the gate.
    resetFlowsheetServiceMock(service, new Date('2026-08-20T18:46:20.000Z'));
    mockGetShowById.mockResolvedValue({ id: 5, primary_dj_id: 'dj-1', end_time: null });
    mockEndShow.mockResolvedValue({ id: 5, primary_dj_id: 'dj-1', end_time: new Date() });
  });

  describe.each([
    ['GET /flowsheet/open-shows', (r: express.Express) => request(r).get('/flowsheet/open-shows')],
    ['POST /flowsheet/shows/:id/force-end', (r: express.Express) => request(r).post('/flowsheet/shows/5/force-end')],
  ])('%s', (_label, call) => {
    test('a musicDirector token is authorized', async () => {
      mockRole('musicDirector');
      const res = await call(app).set('Authorization', 'Bearer test-token');
      expect(res.status).toBe(200);
    });

    test('a stationManager token is authorized', async () => {
      mockRole('stationManager');
      const res = await call(app).set('Authorization', 'Bearer test-token');
      expect(res.status).toBe(200);
    });

    test('an admin token is authorized (normalizeRole maps admin -> stationManager)', async () => {
      mockRole('admin');
      const res = await call(app).set('Authorization', 'Bearer test-token');
      expect(res.status).toBe(200);
    });

    // The load-bearing assertion: a plain DJ holds flowsheet:write and is
    // admitted by every other write route in this router. It must not reach
    // these two.
    test('a dj token is rejected with 403', async () => {
      mockRole('dj');
      const res = await call(app).set('Authorization', 'Bearer test-token');
      expect(res.status).toBe(403);
      expect(mockGetOpenShows).not.toHaveBeenCalled();
      expect(mockEndShow).not.toHaveBeenCalled();
    });

    test('a member token is rejected with 403', async () => {
      mockRole('member');
      const res = await call(app).set('Authorization', 'Bearer test-token');
      expect(res.status).toBe(403);
      expect(mockEndShow).not.toHaveBeenCalled();
    });

    test('a request with no Authorization header is rejected with 401', async () => {
      const res = await call(app);
      expect(res.status).toBe(401);
      expect(mockGetOpenShows).not.toHaveBeenCalled();
      expect(mockEndShow).not.toHaveBeenCalled();
    });
  });
});
