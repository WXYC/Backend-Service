// Same real-middleware harness as intake-file.route.test.ts (the shared `@wxyc/authentication` stub ignores the permission argument).
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

const mockPrintIntakeItem = jestGlobals.fn<(...args: any[]) => Promise<any>>();
const mockFinalizeIntakeItem = jestGlobals.fn<(...args: any[]) => Promise<any>>();

jest.mock('@wxyc/database', () => ({
  intakeItemStateEnum: jest.requireActual('../../../shared/database/src/schema').intakeItemStateEnum,
}));
jest.mock('../../../apps/backend/services/intake.service', () => ({ finalizeIntakeItem: mockFinalizeIntakeItem }));
jest.mock('../../../apps/backend/services/review-print.service', () => ({ printIntakeItem: mockPrintIntakeItem }));
jest.mock('../../../apps/backend/services/library-filing.service', () => ({}));

import { intake_route } from '../../../apps/backend/routes/intake.route';
import errorHandler from '../../../apps/backend/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/intake', intake_route);
app.use(errorHandler);

const SLIP = { artist_name: 'Juana Molina', album_title: 'DOGA', revision_id: 55, fcc_notes: [] };
const ITEM = { id: 7, state: 'finalized', effective_state: 'finalized' };
const call = (action: 'print' | 'finalize', id: string | number = 7) =>
  request(app).post(`/intake/${id}/${action}`).set('Authorization', 'Bearer t');

beforeEach(() => {
  mockedJwtVerify.mockReset();
  mockPrintIntakeItem.mockReset().mockResolvedValue({ outcome: 'printed', slip: SLIP });
  mockFinalizeIntakeItem.mockReset().mockResolvedValue({ outcome: 'finalized', item: ITEM });
});

describe('grants (BS#2804)', () => {
  test.each(['print', 'finalize'] as const)(
    '%s admits a music director and refuses member, dj and no role with 403 before any query',
    async (action) => {
      const service = action === 'print' ? mockPrintIntakeItem : mockFinalizeIntakeItem;
      mockRole('musicDirector');
      expect((await call(action)).status).toBe(200);
      service.mockClear();
      for (const role of ['member', 'dj', undefined]) {
        mockRole(role);
        expect((await call(action)).status).toBe(403);
      }
      expect(service).not.toHaveBeenCalled();
    }
  );

  // `reviews: manage` and `catalog: write` select the same roles today, so withhold one grant from a music director to see which the route asks for.
  test.each([
    ['print', 'reviews', 403],
    ['print', 'catalog', 200],
    ['finalize', 'catalog', 403],
    ['finalize', 'reviews', 200],
  ] as const)('%s with `%s` withheld from a music director answers %i', async (action, withheld, status) => {
    mockRole('musicDirector');
    const authorize = WXYCRoles.musicDirector.authorize as (statement: Record<string, string[]>) => {
      success: boolean;
    };
    const original = authorize.bind(WXYCRoles.musicDirector);
    jest
      .spyOn(WXYCRoles.musicDirector as { authorize: typeof authorize }, 'authorize')
      .mockImplementation((statement) => (withheld in statement ? { success: false } : original(statement)));
    expect((await call(action)).status).toBe(status);
    jest.restoreAllMocks();
  });
});

describe('POST /intake/:id/print (BS#2804)', () => {
  beforeEach(() => mockRole('musicDirector'));

  test('answers the slip and hands the service the item and the caller', async () => {
    const res = await call('print');
    expect([res.status, res.body]).toEqual([200, SLIP]);
    expect(mockPrintIntakeItem).toHaveBeenCalledWith(7, { id: 'caller-id', manage: true });
  });

  test.each([
    [{ outcome: 'not_found' }, 404, undefined],
    [{ outcome: 'not_reviewed' }, 409, 'not_reviewed'],
  ])('%j answers %i', async (result, status, reason) => {
    mockPrintIntakeItem.mockResolvedValue(result);
    const res = await call('print');
    expect([res.status, res.body.reason]).toEqual([status, reason]);
  });

  test('a malformed id is a 400 before any query', async () => {
    expect((await call('print', 'seven')).status).toBe(400);
    expect(mockPrintIntakeItem).not.toHaveBeenCalled();
  });
});

describe('POST /intake/:id/finalize (BS#2804)', () => {
  beforeEach(() => mockRole('musicDirector'));

  test('answers the item and hands the service the caller', async () => {
    const res = await call('finalize');
    expect([res.status, res.body]).toEqual([200, ITEM]);
    expect(mockFinalizeIntakeItem).toHaveBeenCalledWith(7, 'caller-id');
  });

  test.each([
    [{ outcome: 'not_found' }, 404, undefined, undefined],
    [{ outcome: 'state_changed' }, 409, 'state_changed', 'Intake item is no longer in the state this action needs'],
    [
      { outcome: 'in_rotation', message: 'The release is still in rotation until 2026-11-05' },
      409,
      'in_rotation',
      'The release is still in rotation until 2026-11-05',
    ],
  ])('%j answers %i', async (result, status, reason, message) => {
    mockFinalizeIntakeItem.mockResolvedValue(result);
    const res = await call('finalize');
    expect([res.status, res.body.reason, res.body.message]).toEqual([status, reason, message ?? res.body.message]);
  });

  test('a malformed id is a 400 before any query', async () => {
    expect((await call('finalize', '0')).status).toBe(400);
    expect(mockFinalizeIntakeItem).not.toHaveBeenCalled();
  });
});
