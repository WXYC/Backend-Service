// Same real-middleware harness as intake-permissions.route.test.ts (the shared
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
const mockRole = (role?: string, sub = 'caller-id') =>
  mockedJwtVerify.mockResolvedValue({
    payload: { sub, email: 'test@wxyc.org', ...(role === undefined ? {} : { role }) },
    protectedHeader: { alg: 'RS256' },
    key: {} as any,
  });

const mockTransition = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockMemberRoles = jestGlobals.fn<(...args: any[]) => Promise<string[]>>();

jest.mock('@wxyc/database', () => ({
  intakeItemStateEnum: jest.requireActual('../../../shared/database/src/schema').intakeItemStateEnum,
}));
const mockNotifyPass = jestGlobals.fn<(...args: any[]) => Promise<void>>();
jest.mock('../../../apps/backend/services/review-notices.service', () => ({ notifyPass: mockNotifyPass }));
jest.mock('../../../apps/backend/services/intake.service', () => ({
  transitionIntakeItem: mockTransition,
  memberRoles: mockMemberRoles,
}));

// The controller imports the filing seam (BS#2803), whose service module reads real schema tables at load.
jest.mock('../../../apps/backend/services/library-filing.service', () => ({}));

import { intake_route } from '../../../apps/backend/routes/intake.route';
import errorHandler from '../../../apps/backend/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/intake', intake_route);
app.use(errorHandler);

const ITEM = { id: 7, state: 'checked_out', effective_state: 'checked_out' };
const post = (path: string, body?: object) =>
  request(app)
    .post(`/intake/7/${path}`)
    .set('Authorization', 'Bearer t')
    .send(body ?? {});

// route → [action the service is asked for, roles that pass the route's grant]
const ROUTES = [
  ['checkout', 'checkout', ['dj', 'musicDirector', 'stationManager']],
  ['release', 'release', ['dj', 'musicDirector', 'stationManager']],
  ['request', 'request', ['musicDirector', 'stationManager']],
  ['cancel-request', 'cancel_request', ['musicDirector', 'stationManager']],
  ['accept', 'accept', ['dj', 'musicDirector', 'stationManager']],
  ['pass', 'pass', ['dj', 'musicDirector', 'stationManager']],
] as const;
const refused = (allowed: readonly string[]) =>
  ['member', 'dj', 'musicDirector', 'stationManager'].filter((r) => !allowed.includes(r));

beforeEach(() => {
  mockedJwtVerify.mockReset();
  mockTransition.mockReset().mockResolvedValue({ outcome: 'updated', item: ITEM });
  mockMemberRoles.mockReset().mockResolvedValue(['dj']);
  mockNotifyPass.mockReset();
});

describe.each(ROUTES)('POST /intake/:id/%s', (path, action, allowed) => {
  const body = path === 'request' ? { dj_id: 'dj-2' } : {};

  test.each(allowed)('%s is authorized and the service is asked for %s', async (role) => {
    mockRole(role);
    const res = await post(path, body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ITEM);
    expect(mockNotifyPass).toHaveBeenCalledTimes(action === 'pass' ? 1 : 0);
    expect(mockTransition).toHaveBeenCalledWith(
      action,
      7,
      { id: 'caller-id', manage: role !== 'dj' },
      path === 'request' ? 'dj-2' : undefined
    );
  });

  test.each([...refused(allowed), undefined])('%s is refused before any query, in any state', async (role) => {
    mockRole(role);
    expect((await post(path, body)).status).toBe(403);
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockMemberRoles).not.toHaveBeenCalled();
  });

  test('state_changed is a 409 with the closed reason', async () => {
    mockRole('stationManager');
    mockTransition.mockResolvedValue({ outcome: 'state_changed' });
    const res = await post(path, body);
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('state_changed');
  });

  if (action === 'pass') {
    // A hung SES must not hold a pass that already committed.
    test('a notice that never settles does not hold the response', async () => {
      mockRole('dj');
      const item = { ...ITEM, artist_name: 'Juana Molina', album_title: 'DOGA' };
      mockTransition.mockResolvedValueOnce({ outcome: 'updated', item });
      mockNotifyPass.mockReturnValueOnce(new Promise<void>(() => {}));
      const res = await post(path, body);
      expect([res.status, res.body]).toEqual([200, item]);
      expect(mockNotifyPass).toHaveBeenCalledWith({ id: 7, artist: 'Juana Molina', album: 'DOGA' }, 'caller-id');
    }, 2000);
  }

  test('a missing item is a 404', async () => {
    mockRole('stationManager');
    mockTransition.mockResolvedValue({ outcome: 'not_found' });
    expect((await post(path, body)).status).toBe(404);
  });

  test('an id past int4 is a 400 before any query', async () => {
    mockRole('stationManager');
    const res = await request(app).post(`/intake/2147483648/${path}`).set('Authorization', 'Bearer t').send(body);
    expect(res.status).toBe(400);
    expect(mockTransition).not.toHaveBeenCalled();
  });
});

describe('identity refusals', () => {
  // A DJ who is not the requested DJ, or not the holder, when the item IS in the right state.
  test.each(['release', 'accept', 'pass'])('%s by a DJ the item does not belong to is a 403', async (path) => {
    mockRole('dj');
    mockTransition.mockResolvedValue({ outcome: 'forbidden' });
    expect((await post(path)).status).toBe(403);
  });

  test('release is asked for with manage false for a DJ, so the holder condition applies', async () => {
    mockRole('dj');
    await post('release');
    expect(mockTransition).toHaveBeenCalledWith('release', 7, { id: 'caller-id', manage: false }, undefined);
  });

  test('release is asked for with manage true for a music director, lifting the holder condition', async () => {
    mockRole('musicDirector');
    await post('release');
    expect(mockTransition).toHaveBeenCalledWith('release', 7, { id: 'caller-id', manage: true }, undefined);
  });
});

describe('POST /intake/:id/request — dj_id', () => {
  beforeEach(() => mockRole('musicDirector'));

  test.each([
    ['missing', {}],
    ['a non-string', { dj_id: 42 }],
    ['an empty string', { dj_id: '' }],
  ])('%s is a 400 and changes nothing', async (_n, body) => {
    expect((await post('request', body)).status).toBe(400);
    expect(mockTransition).not.toHaveBeenCalled();
  });

  test('an unknown account (no membership) is a 400 and changes nothing', async () => {
    mockMemberRoles.mockResolvedValue([]);
    expect((await post('request', { dj_id: 'ghost' })).status).toBe(400);
    expect(mockTransition).not.toHaveBeenCalled();
  });

  test('a member (reviews: []) is a 400 and changes nothing', async () => {
    mockMemberRoles.mockResolvedValue(['member']);
    expect((await post('request', { dj_id: 'm-1' })).status).toBe(400);
    expect(mockTransition).not.toHaveBeenCalled();
  });

  test('a DJ is a 200', async () => {
    mockMemberRoles.mockResolvedValue(['dj']);
    expect((await post('request', { dj_id: 'dj-2' })).status).toBe(200);
    expect(mockMemberRoles).toHaveBeenCalledWith('dj-2');
  });
});
