// Same real-middleware harness as intake-accept-review.route.test.ts (the shared
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
import { WXYCRoles } from '../../../shared/authentication/src/auth.roles';

const mockedJwtVerify = jwtVerify as jest.MockedFunction<typeof jwtVerify>;
const mockRole = (role?: string) =>
  mockedJwtVerify.mockResolvedValue({
    payload: { sub: 'caller-id', email: 'test@wxyc.org', ...(role === undefined ? {} : { role }) },
    protectedHeader: { alg: 'RS256' },
    key: {} as any,
  });

const mockFileIntakeItem = jestGlobals.fn<(...args: any[]) => Promise<any>>();
const mockPlanLibraryFiling = jestGlobals.fn<(...args: any[]) => Promise<any>>();
const mockCompleteLibraryFiling = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();

jest.mock('@wxyc/database', () => ({
  intakeItemStateEnum: jest.requireActual('../../../shared/database/src/schema').intakeItemStateEnum,
}));
jest.mock('../../../apps/backend/services/intake.service', () => ({ fileIntakeItem: mockFileIntakeItem }));
jest.mock('../../../apps/backend/services/library-filing.service', () => ({
  planLibraryFiling: mockPlanLibraryFiling,
  completeLibraryFiling: mockCompleteLibraryFiling,
}));
// The controller imports the print seam (BS#2804), whose service module reads real schema tables at load.
jest.mock('../../../apps/backend/services/review-print.service', () => ({}));

import { intake_route } from '../../../apps/backend/routes/intake.route';
import errorHandler from '../../../apps/backend/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/intake', intake_route);
app.use(errorHandler);

const ITEM = { id: 7, state: 'filed', effective_state: 'filed', album_id: 42 };
const FILED = { release: { id: 42 } };
const INPUT = { release: { album_title: 'DOGA' } };
const file = (body?: object, id: string | number = 7) =>
  request(app)
    .post(`/intake/${id}/file`)
    .set('Authorization', 'Bearer t')
    .send(body ?? {});

beforeEach(() => {
  mockedJwtVerify.mockReset();
  mockFileIntakeItem.mockReset().mockResolvedValue({ outcome: 'filed', item: ITEM, filed: undefined });
  mockPlanLibraryFiling.mockReset().mockResolvedValue({ kind: 'ok', input: INPUT });
  mockCompleteLibraryFiling.mockReset();
});

describe('POST /intake/:id/file grants (BS#2803)', () => {
  test.each(['musicDirector', 'stationManager'])('%s holds both grants and is allowed', async (role) => {
    mockRole(role);
    expect((await file({ kind: 'existing_release', album_id: 9 })).status).toBe(200);
  });

  test.each(['member', 'dj', undefined])('%s is refused with 403 before any query', async (role) => {
    mockRole(role);
    expect((await file({ kind: 'existing_release', album_id: 9 })).status).toBe(403);
    expect(mockFileIntakeItem).not.toHaveBeenCalled();
  });

  // No role holds one of the two grants without the other, so the other is withheld from a music director.
  test.each([['reviews'], ['catalog']])('a caller without `%s` is refused even holding the other', async (withheld) => {
    mockRole('musicDirector');
    const authorize = WXYCRoles.musicDirector.authorize as (statement: Record<string, string[]>) => {
      success: boolean;
    };
    const original = authorize.bind(WXYCRoles.musicDirector);
    jest
      .spyOn(WXYCRoles.musicDirector as { authorize: typeof authorize }, 'authorize')
      .mockImplementation((statement) => (withheld in statement ? { success: false } : original(statement)));
    expect((await file({ kind: 'existing_release', album_id: 9 })).status).toBe(403);
    expect(mockFileIntakeItem).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});

describe('POST /intake/:id/file arms (BS#2803)', () => {
  beforeEach(() => mockRole('musicDirector'));

  test('existing_release hands the service the album and the caller, and answers the item', async () => {
    const res = await file({ kind: 'existing_release', album_id: 9 });
    expect(res.body).toEqual(ITEM);
    expect(mockFileIntakeItem).toHaveBeenCalledWith(7, { kind: 'existing_release', album_id: 9 }, 'caller-id');
    expect(mockPlanLibraryFiling).not.toHaveBeenCalled();
  });

  test('new_release plans the body, files the plan, and runs the post-commit tail with the plan after the commit', async () => {
    mockFileIntakeItem.mockResolvedValue({ outcome: 'filed', item: ITEM, filed: FILED });
    const body = { kind: 'new_release', artist: { kind: 'existing', artist_id: 1 }, release: { album_title: 'DOGA' } };
    const res = await file(body);
    expect(res.body).toEqual(ITEM);
    expect(mockPlanLibraryFiling).toHaveBeenCalledWith(body);
    expect(mockFileIntakeItem).toHaveBeenCalledWith(7, { kind: 'new_release', input: INPUT }, 'caller-id');
    expect(mockCompleteLibraryFiling).toHaveBeenCalledWith(FILED, INPUT);
  });

  test('a planned conflict answers its body as a 409 before the service is called', async () => {
    const conflict = { message: 'Artist name already exists in that genre.', reason: 'artist_name_conflict' };
    mockPlanLibraryFiling.mockResolvedValue({ kind: 'conflict', body: conflict });
    const res = await file({ kind: 'new_release' });
    expect([res.status, res.body]).toEqual([409, conflict]);
    expect(mockFileIntakeItem).not.toHaveBeenCalled();
  });

  test.each([
    [{}, 'no kind'],
    [{ kind: 'neither' }, 'an unknown kind'],
    [{ kind: 'existing_release' }, 'no album_id'],
    [{ kind: 'existing_release', album_id: 'nine' }, 'a malformed album_id'],
  ])('%j (%s) is a 400 before any query', async (body) => {
    expect((await file(body)).status).toBe(400);
    expect(mockFileIntakeItem).not.toHaveBeenCalled();
  });

  test('the filing refusal for an item with no accepted review keeps its own message', async () => {
    mockFileIntakeItem.mockResolvedValue({ outcome: 'not_reviewed' });
    const res = await file({ kind: 'existing_release', album_id: 9 });
    expect(res.body.message).toEqual('Intake item has no accepted review');
  });

  test.each([
    [{ outcome: 'not_found' }, 404, undefined],
    [{ outcome: 'unknown_album' }, 400, undefined],
    [{ outcome: 'state_changed' }, 409, 'state_changed'],
    [{ outcome: 'not_reviewed' }, 409, 'not_reviewed'],
    [
      { outcome: 'filing_conflict', body: { message: 'm', reason: 'rotation_card_bin_mismatch' } },
      409,
      'rotation_card_bin_mismatch',
    ],
  ])('%j answers %i', async (result, status, reason) => {
    mockFileIntakeItem.mockResolvedValue(result);
    const res = await file({ kind: 'existing_release', album_id: 9 });
    expect(res.status).toBe(status);
    expect(res.body.reason).toBe(reason);
    expect(mockCompleteLibraryFiling).not.toHaveBeenCalled();
  });
});
