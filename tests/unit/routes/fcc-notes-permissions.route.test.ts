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
const mockListReported = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockConfirm = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockDelete = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockNotify = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();

jest.mock('@wxyc/database', () => ({}));
jest.mock('../../../apps/backend/services/fcc-notes.service', () => ({
  createFccNote: mockCreate,
  listFccNotes: mockList,
  listReportedFccNotes: mockListReported,
  confirmFccNote: mockConfirm,
  deleteFccNote: mockDelete,
}));
// The notifier never rejects (tests/unit/services/review-notices.service.test.ts pins that, and the swallowed send failure), so the controller's `void` call is all this file pins.
jest.mock('../../../apps/backend/services/review-notices.service', () => ({
  notifyFccNoteReported: (...args: any[]) => mockNotify(...args),
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
const confirm = (id: string | number) => request(app).post(`/fcc-notes/${id}/confirm`).set('Authorization', 'Bearer t');
const remove = (id: string | number) => request(app).delete(`/fcc-notes/${id}`).set('Authorization', 'Bearer t');

beforeEach(() => {
  mockedJwtVerify.mockReset();
  mockCreate.mockReset().mockResolvedValue({ outcome: 'created', note: NOTE, notice: {} });
  mockList.mockReset().mockResolvedValue([NOTE]);
  mockListReported.mockReset().mockResolvedValue([NOTE]);
  mockConfirm.mockReset().mockResolvedValue({ outcome: 'confirmed', note: { ...NOTE, status: 'confirmed' } });
  mockDelete.mockReset().mockResolvedValue({ outcome: 'deleted' });
  mockNotify.mockReset().mockResolvedValue(undefined);
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
    expect(mockNotify).not.toHaveBeenCalled();
  });

  describe('the notice to the music directors (BS#2863)', () => {
    const NOTICE = { note: NOTE, artist: 'Juana Molina', album: 'DOGA', reporterUserId: 'caller-id' };
    beforeEach(() => mockCreate.mockResolvedValue({ outcome: 'created', note: NOTE, notice: NOTICE }));

    test('a DJ’s report sends the notice once, with what the create returned', async () => {
      mockRole('dj');
      expect((await post(body)).status).toBe(200);
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockNotify).toHaveBeenCalledWith(NOTICE);
    });

    test.each(['musicDirector', 'stationManager'])('a report by a %s sends none', async (role) => {
      mockRole(role);
      expect((await post(body)).status).toBe(200);
      expect(mockNotify).not.toHaveBeenCalled();
    });

    test('the response does not wait for the send, so a slow or hung send never holds a committed report', async () => {
      mockRole('dj');
      mockNotify.mockReturnValue(new Promise(() => {}));
      expect((await post(body)).status).toBe(200);
    });
  });
});

describe('POST /fcc-notes/{id}/confirm (BS#2863)', () => {
  test.each(['musicDirector', 'stationManager'])('%s may confirm', async (role) => {
    mockRole(role);
    const res = await confirm(5);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 5, status: 'confirmed' });
    expect(mockConfirm).toHaveBeenCalledWith(5, { id: 'caller-id', manage: true });
  });

  test.each(['dj', 'member', undefined])('%s is refused before any query', async (role) => {
    mockRole(role);
    expect((await confirm(5)).status).toBe(403);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test.each(['abc', '0', '-1', '2147483648', '1.5'])('an id of %s is a 400 before any query', async (id) => {
    mockRole('musicDirector');
    expect((await confirm(id)).status).toBe(400);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test.each([
    ['not_found', 404],
    ['no_account', 403],
  ])('%s is a %i', async (outcome, status) => {
    mockRole('musicDirector');
    mockConfirm.mockResolvedValue({ outcome });
    expect((await confirm(5)).status).toBe(status);
  });
});

describe('DELETE /fcc-notes/{id} (BS#2863)', () => {
  test.each(['dj', 'musicDirector', 'stationManager'])('%s reaches the service, which decides', async (role) => {
    mockRole(role);
    const res = await remove(5);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(mockDelete).toHaveBeenCalledWith(5, { id: 'caller-id', manage: role !== 'dj' });
  });

  test.each(['member', undefined])('%s is refused before any query', async (role) => {
    mockRole(role);
    expect((await remove(5)).status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test.each(['abc', '0', '2147483648'])('an id of %s is a 400 before any query', async (id) => {
    mockRole('dj');
    expect((await remove(id)).status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test.each([
    ['not_found', 404],
    ['forbidden', 403],
  ])('%s is a %i', async (outcome, status) => {
    mockRole('dj');
    mockDelete.mockResolvedValue({ outcome });
    expect((await remove(5)).status).toBe(status);
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
    '?status=confirmed',
    '?status=bogus',
    '?status=reported&status=confirmed',
    '?status=bogus&album_id=9',
    '?status=reported&album_id=9&intake_item_id=4',
  ])('%s is a 400 before any query', async (query) => {
    expect((await get(query)).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockListReported).not.toHaveBeenCalled();
  });

  test.each([
    ['?album_id=9&status=confirmed', { album_id: 9, status: 'confirmed' }],
    ['?intake_item_id=4&status=reported', { intake_item_id: 4, status: 'reported' }],
  ])('%s asks for that one status of the record', async (query, filter) => {
    expect((await get(query)).status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(filter);
  });
});

describe('GET /fcc-notes?status=reported with no subject: the waiting list (BS#2863)', () => {
  test.each(['musicDirector', 'stationManager'])('%s gets every unconfirmed note', async (role) => {
    mockRole(role);
    const res = await get('?status=reported');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([NOTE]);
    expect(mockListReported).toHaveBeenCalledTimes(1);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('a DJ is refused before any query', async () => {
    mockRole('dj');
    expect((await get('?status=reported')).status).toBe(403);
    expect(mockListReported).not.toHaveBeenCalled();
  });

  test.each(['?status=confirmed', ''])('%s with no subject is a 400 for a music director too', async (query) => {
    mockRole('musicDirector');
    expect((await get(query)).status).toBe(400);
  });

  test('a record’s list stays open to a DJ', async () => {
    mockRole('dj');
    expect((await get('?album_id=9&status=reported')).status).toBe(200);
  });
});
