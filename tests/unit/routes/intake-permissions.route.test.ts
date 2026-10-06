// Set required env vars before module load (ts-jest transforms imports to
// requires, so these execute before the auth middleware module's top-level
// code runs). Mirrors tests/unit/routes/album-reviews-permissions.route.test.ts.
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';
delete process.env.AUTH_BYPASS;

// Mock jose so we can hand back an arbitrary role in the verified JWT payload
// without a real JWKS endpoint. The integration tier runs AUTH_BYPASS=true, so
// it cannot exercise this router's grants -- hence this real-middleware test.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));

// The shared `@wxyc/authentication` stub ignores the permission argument, so
// wire the REAL middleware back in, plus the role table the controller reads to
// decide whether the caller may see `passes`. Extending the shared stub would
// change behavior for every unit test in the repo.
jest.mock('@wxyc/authentication', () => ({
  ...jest.requireActual('../../../shared/authentication/src/auth.middleware'),
  ...jest.requireActual('../../../shared/authentication/src/auth.roles'),
}));

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

const ITEM = { id: 7, artist_name: 'Juana Molina', album_title: 'DOGA', state: 'pool', effective_state: 'pool' };

const mockListIntakeItems = jestGlobals.fn<(...args: any[]) => Promise<unknown[]>>();
const mockGetIntakeItem = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockLogIntakeItem = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockUpdateIntakeItem = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();
const mockDeleteIntakeItem = jestGlobals.fn<(...args: any[]) => Promise<unknown>>();

// The shared `@wxyc/database` stub has no enums; `?state=` validation reads the
// real one, so the test cannot drift from `intakeItemStateEnum`'s values.
jest.mock('@wxyc/database', () => ({
  intakeItemStateEnum: jest.requireActual('../../../shared/database/src/schema').intakeItemStateEnum,
}));

jest.mock('../../../apps/backend/services/intake.service', () => ({
  listIntakeItems: mockListIntakeItems,
  getIntakeItem: mockGetIntakeItem,
  logIntakeItem: mockLogIntakeItem,
  updateIntakeItem: mockUpdateIntakeItem,
  deleteIntakeItem: mockDeleteIntakeItem,
}));

import { intake_route } from '../../../apps/backend/routes/intake.route';
import errorHandler from '../../../apps/backend/middleware/errorHandler';

const app = express();
app.use(express.json());
app.use('/intake', intake_route);
app.use(errorHandler);

const NEW_ITEM = { artist_name: 'Juana Molina', album_title: 'DOGA', format_id: 1 };

type Call = { name: string; send: (token: string) => request.Test };
const bearer = (t: request.Test) => t.set('Authorization', 'Bearer test-token');
const READS: Call[] = [
  { name: 'GET /intake', send: () => bearer(request(app).get('/intake')) },
  { name: 'GET /intake/7', send: () => bearer(request(app).get('/intake/7')) },
];
const WRITES: Call[] = [
  { name: 'POST /intake', send: () => bearer(request(app).post('/intake').send(NEW_ITEM)) },
  { name: 'PATCH /intake/7', send: () => bearer(request(app).patch('/intake/7').send({ album_title: 'DOGA' })) },
  { name: 'DELETE /intake/7', send: () => bearer(request(app).delete('/intake/7')) },
];

describe('/intake — reviews grants (BS#2796)', () => {
  beforeEach(() => {
    mockedJwtVerify.mockReset();
    mockListIntakeItems.mockReset().mockResolvedValue([ITEM]);
    mockGetIntakeItem.mockReset().mockResolvedValue(ITEM);
    mockLogIntakeItem.mockReset().mockResolvedValue({ outcome: 'logged', item: ITEM });
    mockUpdateIntakeItem.mockReset().mockResolvedValue({ outcome: 'updated', item: ITEM });
    mockDeleteIntakeItem.mockReset().mockResolvedValue({ outcome: 'deleted', authors: [] });
  });

  const allMocks = () => [
    mockListIntakeItems,
    mockGetIntakeItem,
    mockLogIntakeItem,
    mockUpdateIntakeItem,
    mockDeleteIntakeItem,
  ];

  describe.each([...READS, ...WRITES])('$name', (call) => {
    test('member is refused', async () => {
      mockRole('member');
      expect((await call.send('t')).status).toBe(403);
      allMocks().forEach((m) => expect(m).not.toHaveBeenCalled());
    });

    test('a role-less (anonymous) token is refused', async () => {
      mockRole(undefined);
      expect((await call.send('t')).status).toBe(403);
      allMocks().forEach((m) => expect(m).not.toHaveBeenCalled());
    });

    test.each(['musicDirector', 'stationManager'] as const)('%s is authorized', async (role) => {
      mockRole(role);
      expect((await call.send('t')).status).toBe(200);
    });
  });

  test.each(READS)('dj may read: $name', async (call) => {
    mockRole('dj');
    expect((await call.send('t')).status).toBe(200);
  });

  test.each(WRITES)('dj may not log, patch or delete: $name', async (call) => {
    mockRole('dj');
    expect((await call.send('t')).status).toBe(403);
    allMocks().forEach((m) => expect(m).not.toHaveBeenCalled());
  });

  test('no Authorization header is 401', async () => {
    expect((await request(app).get('/intake')).status).toBe(401);
  });
});

describe('/intake — passes visibility', () => {
  beforeEach(() => {
    mockedJwtVerify.mockReset();
    mockListIntakeItems.mockReset().mockResolvedValue([ITEM]);
    mockGetIntakeItem.mockReset().mockResolvedValue(ITEM);
  });

  test.each([
    ['dj', false],
    ['musicDirector', true],
    ['stationManager', true],
  ] as const)('list for %s asks for passes: %s', async (role, expected) => {
    mockRole(role);
    await bearer(request(app).get('/intake'));
    expect(mockListIntakeItems).toHaveBeenCalledWith({
      state: undefined,
      includePasses: expected,
      awaitingAcceptance: false,
    });
  });

  test.each([
    ['dj', false],
    ['musicDirector', true],
  ] as const)('get for %s asks for passes: %s', async (role, expected) => {
    mockRole(role);
    await bearer(request(app).get('/intake/7'));
    expect(mockGetIntakeItem).toHaveBeenCalledWith(7, expected);
  });
});

describe('GET /intake — ?state=', () => {
  beforeEach(() => {
    mockedJwtVerify.mockReset();
    mockListIntakeItems.mockReset().mockResolvedValue([]);
    mockRole('dj');
  });

  test('bogus state is a 400 in the standard error shape, before any query runs', async () => {
    const res = await bearer(request(app).get('/intake').query({ state: 'bogus' }));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      'Invalid Parameter: state must be one of pool, requested, checked_out, reviewed, filed, finalized'
    );
    expect(mockListIntakeItems).not.toHaveBeenCalled();
  });

  test('a repeated state param (array) is a 400, not a 500', async () => {
    const res = await bearer(request(app).get('/intake?state=pool&state=filed'));
    expect(res.status).toBe(400);
  });

  test.each(['pool', 'requested', 'checked_out', 'reviewed', 'filed', 'finalized'])('accepts %s', async (state) => {
    const res = await bearer(request(app).get('/intake').query({ state }));
    expect(res.status).toBe(200);
    expect(mockListIntakeItems).toHaveBeenCalledWith({ state, includePasses: false, awaitingAcceptance: false });
  });

  // BS#2860: `false` is the same as leaving it out; anything else, a repeated key included, is a 400.
  test.each([
    ['true', true],
    ['false', false],
  ])('awaiting_acceptance=%s is passed through as %s, alongside state', async (raw, expected) => {
    const res = await bearer(request(app).get('/intake').query({ awaiting_acceptance: raw, state: 'pool' }));
    expect(res.status).toBe(200);
    expect(mockListIntakeItems).toHaveBeenCalledWith({
      state: 'pool',
      includePasses: false,
      awaitingAcceptance: expected,
    });
  });

  test.each(['1', 'yes', 'TRUE', ''])('awaiting_acceptance=%j is a 400 before any query', async (raw) => {
    const res = await bearer(request(app).get('/intake').query({ awaiting_acceptance: raw }));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid Parameter: awaiting_acceptance must be true or false');
    expect(mockListIntakeItems).not.toHaveBeenCalled();
  });

  test('a repeated awaiting_acceptance is a 400', async () => {
    expect((await bearer(request(app).get('/intake?awaiting_acceptance=true&awaiting_acceptance=true'))).status).toBe(
      400
    );
  });
});

describe('/intake/:id and bodies', () => {
  beforeEach(() => {
    mockedJwtVerify.mockReset();
    mockGetIntakeItem.mockReset().mockResolvedValue(ITEM);
    mockLogIntakeItem.mockReset().mockResolvedValue({ outcome: 'logged', item: ITEM });
    mockUpdateIntakeItem.mockReset().mockResolvedValue({ outcome: 'updated', item: ITEM });
    mockDeleteIntakeItem.mockReset().mockResolvedValue({ outcome: 'deleted', authors: [] });
    mockRole('musicDirector');
  });

  test('a non-numeric id is a 400', async () => {
    expect((await bearer(request(app).get('/intake/abc'))).status).toBe(400);
  });

  // `intake_items.id` is int4: an id past it would reach Postgres as a 22003 and answer 500.
  const BY_ID = [
    ['GET', (id: string) => request(app).get(`/intake/${id}`), mockGetIntakeItem],
    ['PATCH', (id: string) => request(app).patch(`/intake/${id}`).send({ album_title: 'DOGA' }), mockUpdateIntakeItem],
    ['DELETE', (id: string) => request(app).delete(`/intake/${id}`), mockDeleteIntakeItem],
  ] as const;

  test.each(BY_ID)('%s of an id past int4 (2147483648) is a 400 before any query', async (_m, send, service) => {
    const res = await bearer(send('2147483648'));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Invalid intake item id');
    expect(service).not.toHaveBeenCalled();
  });

  test.each(BY_ID)('%s accepts the int4 ceiling (2147483647) as an id', async (_m, send, service) => {
    expect((await bearer(send('2147483647'))).status).toBe(200);
    expect(service.mock.calls[0][0]).toBe(2147483647);
  });

  test('GET of a missing item is a 404', async () => {
    mockGetIntakeItem.mockResolvedValue(undefined);
    expect((await bearer(request(app).get('/intake/7'))).status).toBe(404);
  });

  test('POST stamps logged_by from the token and trims the text trio', async () => {
    await bearer(
      request(app)
        .post('/intake')
        .send({ ...NEW_ITEM, artist_name: '  Juana Molina ', record_label: ' Sonamos ' })
    );
    expect(mockLogIntakeItem).toHaveBeenCalledWith(
      {
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        record_label: 'Sonamos',
        label_id: undefined,
        format_id: 1,
        discogs_release_id: undefined,
      },
      'test-user-id'
    );
  });

  test.each([
    ['missing artist_name', { album_title: 'DOGA', format_id: 1 }],
    ['blank album_title', { ...NEW_ITEM, album_title: '   ' }],
    ['over-length artist_name', { ...NEW_ITEM, artist_name: 'x'.repeat(129) }],
    ['over-length record_label', { ...NEW_ITEM, record_label: 'x'.repeat(129) }],
    ['missing format_id', { artist_name: 'a', album_title: 'b' }],
    ['non-integer format_id', { ...NEW_ITEM, format_id: 1.5 }],
    ['string label_id', { ...NEW_ITEM, label_id: '3' }],
    ['discogs_release_id past int4', { ...NEW_ITEM, discogs_release_id: 2147483648 }],
  ])('POST with %s is a 400 and writes nothing', async (_name, body) => {
    expect((await bearer(request(app).post('/intake').send(body))).status).toBe(400);
    expect(mockLogIntakeItem).not.toHaveBeenCalled();
  });

  test('POST with an unknown format_id/label_id answers 400', async () => {
    mockLogIntakeItem.mockResolvedValue({ outcome: 'unknown_reference' });
    expect((await bearer(request(app).post('/intake').send(NEW_ITEM))).status).toBe(400);
  });

  test.each([
    ['a release', { cited_album_id: 5 }],
    ['a submission', { cited_submission_id: 5 }],
    ['an explicit-null switch', { cited_album_id: null, cited_submission_id: 5 }],
    ['a clear', { cited_album_id: null }],
  ])('PATCH of a citation alone (%s) is passed on as the only field', async (_name, body) => {
    mockUpdateIntakeItem.mockResolvedValueOnce({ outcome: 'updated', item: ITEM });
    expect((await bearer(request(app).patch('/intake/7').send(body))).status).toBe(200);
    expect(mockUpdateIntakeItem).toHaveBeenCalledWith(7, body);
  });

  test.each([
    ['both citations set', { cited_album_id: 5, cited_submission_id: 6 }],
    ['cited_album_id past int4', { cited_album_id: 2147483648 }],
    ['a non-integer cited_submission_id', { cited_submission_id: 1.5 }],
  ])('PATCH with %s is a 400 and writes nothing', async (_name, body) => {
    expect((await bearer(request(app).patch('/intake/7').send(body))).status).toBe(400);
    expect(mockUpdateIntakeItem).not.toHaveBeenCalled();
  });

  test('POST ignores citation keys: a new item starts uncited', async () => {
    mockLogIntakeItem.mockResolvedValue({ outcome: 'logged', item: ITEM });
    await bearer(
      request(app)
        .post('/intake')
        .send({ ...NEW_ITEM, cited_album_id: 5 })
    );
    expect(mockLogIntakeItem.mock.calls[0][0]).not.toHaveProperty('cited_album_id');
  });

  test('PATCH of an invalid citation is a 409 invalid_citation', async () => {
    mockUpdateIntakeItem.mockResolvedValueOnce({ outcome: 'invalid_citation' });
    const res = await bearer(request(app).patch('/intake/7').send({ cited_album_id: 5 }));
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('invalid_citation');
  });

  test('an invalid citation sent to a filed item is a 409 already_filed', async () => {
    mockUpdateIntakeItem.mockResolvedValueOnce({ outcome: 'already_filed' });
    const res = await bearer(request(app).patch('/intake/7').send({ cited_album_id: 5 }));
    expect(res.body.reason).toBe('already_filed');
  });

  test('PATCH with no editable field is a 400', async () => {
    expect((await bearer(request(app).patch('/intake/7').send({}))).status).toBe(400);
  });

  test('PATCH passes only the supplied fields on, normalized', async () => {
    await bearer(request(app).patch('/intake/7').send({ record_label: '', label_id: null }));
    expect(mockUpdateIntakeItem).toHaveBeenCalledWith(7, { record_label: null, label_id: null });
  });

  test('PATCH of a missing item is a 404; of a filed item a 409 already_filed', async () => {
    mockUpdateIntakeItem.mockResolvedValueOnce({ outcome: 'not_found' });
    expect((await bearer(request(app).patch('/intake/7').send({ album_title: 'x' }))).status).toBe(404);

    mockUpdateIntakeItem.mockResolvedValueOnce({ outcome: 'already_filed' });
    const res = await bearer(request(app).patch('/intake/7').send({ album_title: 'x' }));
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('already_filed');
    expect(typeof res.body.message).toBe('string');
  });

  test.each([[[]], [['Test Reviewer', 'Test Reviewer', 'Test Visiting DJ']]])(
    'DELETE answers deleted_review_authors with the authors the service names: %j',
    async (authors) => {
      mockDeleteIntakeItem.mockResolvedValueOnce({ outcome: 'deleted', authors });
      const res = await bearer(request(app).delete('/intake/7'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted_review_authors: authors });
    }
  );

  test('DELETE of a filed item is a 409 already_filed; of a missing one a 404', async () => {
    mockDeleteIntakeItem.mockResolvedValueOnce({ outcome: 'already_filed' });
    const filed = await bearer(request(app).delete('/intake/7'));
    expect(filed.status).toBe(409);
    expect(filed.body.reason).toBe('already_filed');

    mockDeleteIntakeItem.mockResolvedValueOnce({ outcome: 'not_found' });
    expect((await bearer(request(app).delete('/intake/7'))).status).toBe(404);
  });
});
