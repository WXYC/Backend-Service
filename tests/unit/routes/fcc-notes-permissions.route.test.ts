// Same real-middleware harness as reviews-permissions.route.test.ts (the shared `@wxyc/authentication` stub ignores
// the permission argument). The service is mocked: its writes are pinned in
// tests/unit/services/fcc-notes.service.test.ts, so this file pins the route grants and the controller's request
// parsing and outcome mapping.
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

const mockCreate = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockList = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();

jest.mock('@wxyc/database', () => ({}));
jest.mock('../../../apps/backend/services/fcc-notes.service', () => ({
  createFccNote: mockCreate,
  listFccNotes: mockList,
}));

import { fcc_notes_route } from '../../../apps/backend/routes/fcc-notes.route';
import errorHandler from '../../../apps/backend/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/fcc-notes', fcc_notes_route);
app.use(errorHandler);

const NOTE = { id: 5, status: 'reported', artist_name: 'Juana Molina', album_title: 'DOGA' };
const body = { album_id: 9, track: 'la paradoja', note: 'A placeholder note.' };
const post = (b: object) => request(app).post('/fcc-notes').set('Authorization', 'Bearer t').send(b);
const get = (query = '') => request(app).get(`/fcc-notes${query}`).set('Authorization', 'Bearer t');

beforeEach(() => {
  mockedJwtVerify.mockReset();
  mockCreate.mockReset().mockResolvedValue({ outcome: 'created', note: NOTE, notice: {} });
  mockList.mockReset().mockResolvedValue([NOTE]);
});

describe('grants', () => {
  test.each(['dj', 'musicDirector', 'stationManager'])('%s may report and list', async (role) => {
    mockRole(role);
    expect((await post(body)).status).toBe(200);
    expect((await get('?album_id=9')).status).toBe(200);
  });

  test.each(['member', undefined])('%s is refused on both before any query', async (role) => {
    mockRole(role);
    expect((await post(body)).status).toBe(403);
    expect((await get('?album_id=9')).status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST /fcc-notes', () => {
  beforeEach(() => mockRole('dj'));

  test('answers 200 with the note and asks the service for the trimmed fields and the caller', async () => {
    const res = await post({ intake_item_id: 4, track: '  B2  ', note: '  a word on the air  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(NOTE);
    expect(mockCreate).toHaveBeenCalledWith(
      { intake_item_id: 4, album_id: undefined },
      { track: 'B2', note: 'a word on the air' },
      { id: 'caller-id', manage: false }
    );
  });

  test.each([
    ['both subjects', { ...body, intake_item_id: 4 }],
    ['no subject', { track: 'B2', note: 'x' }],
    ['an album_id of 0', { ...body, album_id: 0 }],
    ['an album_id past int4', { ...body, album_id: 2147483648 }],
    ['a string album_id', { ...body, album_id: '9' }],
    ['no track', { album_id: 9, note: 'x' }],
    ['a blank track', { ...body, track: '   ' }],
    ['no note', { album_id: 9, track: 'B2' }],
    ['a blank note', { ...body, note: ' ' }],
    ['a track that is not text', { ...body, track: 4 }],
  ])('%s is a 400 before any query', async (_name, b) => {
    expect((await post(b)).status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test.each([
    [{ album_id: 9 }, 'No such library release'],
    [{ intake_item_id: 4 }, 'No such intake item'],
  ])('a subject %j that names nothing is a 400', async (subject, message) => {
    mockCreate.mockResolvedValue({ outcome: 'unknown_subject' });
    const res = await post({ ...subject, track: 'B2', note: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
  });

  test('a caller with no account name is a 403', async () => {
    mockCreate.mockResolvedValue({ outcome: 'no_account' });
    expect((await post(body)).status).toBe(403);
  });
});

describe('GET /fcc-notes', () => {
  beforeEach(() => mockRole('dj'));

  test.each([
    ['?album_id=9', { album_id: 9 }],
    ['?intake_item_id=4', { intake_item_id: 4 }],
  ])('%s asks the service for that one filter and answers the bare array', async (query, filter) => {
    const res = await get(query);
    expect(res.body).toEqual([NOTE]);
    expect(mockList).toHaveBeenCalledWith(filter);
  });

  test.each([
    '',
    '?album_id=9&intake_item_id=4',
    '?album_id=0',
    '?album_id=2147483648',
    '?album_id=abc',
    '?album_id=1&album_id=2',
    '?intake_item_id=-1',
  ])('%s is a 400 before any query', async (query) => {
    expect((await get(query)).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});
