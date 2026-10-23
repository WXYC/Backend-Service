/**
 * Route wiring for the label admin operations (BS#3289): the gating tier of each verb, the controller's input
 * validation, and the status/body each service outcome maps to. The SQL behind them is pinned against real
 * migrations by `tests/integration/labels.spec.js`.
 */
process.env.BETTER_AUTH_JWKS_URL = 'https://test.example.com/.well-known/jwks.json';
process.env.BETTER_AUTH_ISSUER = 'https://test.example.com';
process.env.BETTER_AUTH_AUDIENCE = 'https://test.example.com';
delete process.env.AUTH_BYPASS;

// The unit suite's `@wxyc/authentication` stub ignores the permission argument, so the real gate is wired back in
// (as in library-delete-permissions.route.test.ts) with `jose` handing back whichever role a test asks for.
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
  decodeJwt: jest.fn(),
}));
jest.mock('@wxyc/authentication', () => jest.requireActual('../../../shared/authentication/src/auth.middleware'));

import { jest } from '@jest/globals';
import { jwtVerify } from 'jose';
import express from 'express';
import request from 'supertest';
import WxycError from '../../../apps/backend/utils/error';
import errorHandler from '../../../apps/backend/middleware/errorHandler';

const mockGetLabelWithReferences = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockUpdateLabel = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockDeleteLabel = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock('../../../apps/backend/services/labels.service', () => ({
  getAllLabels: jest.fn(),
  getLabelById: jest.fn(),
  createLabel: jest.fn(),
  searchLabels: jest.fn(),
  getLabelWithReferences: mockGetLabelWithReferences,
  updateLabel: mockUpdateLabel,
  deleteLabel: mockDeleteLabel,
}));

import { labels_route } from '../../../apps/backend/routes/labels.route';

const app = express();
app.use(express.json());
app.use('/labels', labels_route);
app.use(errorHandler);

const AUTH = { Authorization: 'Bearer test-token' };
const mockRole = (role: string) =>
  (jwtVerify as jest.MockedFunction<typeof jwtVerify>).mockResolvedValue({
    payload: { sub: 'test-user-id', email: 'test@wxyc.org', role },
    protectedHeader: { alg: 'RS256' },
  });
const NO_REFS = { library: 0, rotation: 0, flowsheet: 0, intake_items: 0 };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  mockRole('musicDirector');
});

describe('permission tiers', () => {
  it('lets a dj (catalog:read) read one label', async () => {
    mockRole('dj');
    mockGetLabelWithReferences.mockResolvedValue({ id: 3 });
    expect((await request(app).get('/labels/3').set(AUTH)).status).toBe(200);
  });

  test.each([
    ['PATCH', 'patch'],
    ['DELETE', 'delete'],
  ] as const)('refuses a dj (catalog:read only) on %s', async (_verb, method) => {
    mockRole('dj');
    const res = await request(app)[method]('/labels/3').set(AUTH).send({ label_name: 'X' });
    expect(res.status).toBe(403);
    expect(mockUpdateLabel).not.toHaveBeenCalled();
    expect(mockDeleteLabel).not.toHaveBeenCalled();
  });
});

describe('requires an Authorization header', () => {
  test.each([
    ['GET', '/labels/3'],
    ['PATCH', '/labels/3'],
    ['DELETE', '/labels/3'],
  ])('%s %s', async (method, url) => {
    const res = await request(app)[method.toLowerCase() as 'get'](url);
    expect(res.status).toBe(401);
  });
});

describe('GET /labels/:id', () => {
  it('returns the label with its reference counts', async () => {
    const body = { id: 3, label_name: 'Sonamos', parent_label_id: null, references: NO_REFS, child_labels: 0 };
    mockGetLabelWithReferences.mockResolvedValue(body);
    const res = await request(app).get('/labels/3').set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
    expect(mockGetLabelWithReferences).toHaveBeenCalledWith(3);
  });

  it('is a 404 when the label is absent', async () => {
    mockGetLabelWithReferences.mockResolvedValue(undefined);
    expect((await request(app).get('/labels/3').set(AUTH)).status).toBe(404);
  });

  it('is a 400 for a non-numeric id', async () => {
    expect((await request(app).get('/labels/abc').set(AUTH)).status).toBe(400);
    expect(mockGetLabelWithReferences).not.toHaveBeenCalled();
  });

  test.each(['0', '-1', '2147483648', '1.5', '1e3'])('is a 400 for the id %s, which no row can have', async (id) => {
    expect((await request(app).get(`/labels/${id}`).set(AUTH)).status).toBe(400);
    expect(mockGetLabelWithReferences).not.toHaveBeenCalled();
  });

  it('still routes /labels/info and /labels/search to their own handlers', async () => {
    expect((await request(app).get('/labels/info').set(AUTH)).status).toBe(400);
    expect((await request(app).get('/labels/search').set(AUTH)).status).toBe(400);
    expect(mockGetLabelWithReferences).not.toHaveBeenCalled();
  });
});

describe('PATCH /labels/:id', () => {
  it('passes the fields through and returns the service result', async () => {
    const result = { label: { id: 3, label_name: 'Drag City', parent_label_id: null }, rewritten: NO_REFS };
    mockUpdateLabel.mockResolvedValue(result);
    const res = await request(app).patch('/labels/3').set(AUTH).send({ label_name: ' Drag City ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(result);
    expect(mockUpdateLabel).toHaveBeenCalledWith(3, { label_name: 'Drag City' });
  });

  it('distinguishes an explicit null parent (detach) from an absent one', async () => {
    mockUpdateLabel.mockResolvedValue({});
    await request(app).patch('/labels/3').set(AUTH).send({ parent_label_id: null });
    expect(mockUpdateLabel).toHaveBeenCalledWith(3, { parent_label_id: null });
  });

  test.each([
    ['an empty body', {}],
    ['a blank name', { label_name: '   ' }],
    ['a non-string name', { label_name: 7 }],
    ['a name over 128 characters', { label_name: 'x'.repeat(129) }],
    ['a non-integer parent', { parent_label_id: 'two' }],
    ['a fractional parent', { parent_label_id: 1.5 }],
    ['a parent past the 32-bit id range', { parent_label_id: 2147483648 }],
    ['a zero parent', { parent_label_id: 0 }],
  ])('refuses %s with a 400 before touching the service', async (_name, body) => {
    const res = await request(app).patch('/labels/3').set(AUTH).send(body);
    expect(res.status).toBe(400);
    expect(mockUpdateLabel).not.toHaveBeenCalled();
  });

  it('is a 404 when the label is absent', async () => {
    mockUpdateLabel.mockResolvedValue(undefined);
    expect((await request(app).patch('/labels/3').set(AUTH).send({ label_name: 'X' })).status).toBe(404);
  });

  it('carries the service error status and code through (name collision)', async () => {
    mockUpdateLabel.mockRejectedValue(new WxycError('taken', 409, { code: 'label_name_taken' }));
    const res = await request(app).patch('/labels/3').set(AUTH).send({ label_name: 'X' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('label_name_taken');
  });
});

describe('DELETE /labels/:id', () => {
  it('is a 204 on success', async () => {
    mockDeleteLabel.mockResolvedValue(true);
    const res = await request(app).delete('/labels/3').set(AUTH);
    expect(res.status).toBe(204);
    expect(mockDeleteLabel).toHaveBeenCalledWith(3);
  });

  it('is a 404 when the label is absent', async () => {
    mockDeleteLabel.mockResolvedValue(false);
    expect((await request(app).delete('/labels/3').set(AUTH)).status).toBe(404);
  });

  it('carries the 409 label_in_use counts through', async () => {
    const details = { references: { ...NO_REFS, library: 2 }, child_labels: 1 };
    mockDeleteLabel.mockRejectedValue(new WxycError('in use', 409, { code: 'label_in_use', details }));
    const res = await request(app).delete('/labels/3').set(AUTH);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ message: 'in use', code: 'label_in_use', details });
  });
});
