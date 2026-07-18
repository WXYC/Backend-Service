/**
 * Route-wiring tests for /concerts (BS#1603, BS#1694).
 *
 * The @wxyc/authentication mock's `requirePermissions` returns 401 when the
 * Authorization header is missing, so these pin the auth tier of each route:
 * the list stays behind anonymous-session auth (any bearer token, no
 * permission scope — matching the /proxy read surfaces), while the by-id
 * read is deliberately PUBLIC (no auth middleware at all) so the
 * `wxyc.org/shows/<id>` share Worker and the iOS universal-link fallback can
 * call it without minting a session (BS#1694 / wxyc-shared#236).
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockGetConcertsPage = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
const mockGetConcertsCount = jest.fn<() => Promise<number>>().mockResolvedValue(0);
const mockGetConcertById = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);

jest.mock('../../../apps/backend/services/concerts.service', () => ({
  getConcertsPage: mockGetConcertsPage,
  getConcertsCount: mockGetConcertsCount,
  getConcertById: mockGetConcertById,
}));

import { concerts_route } from '../../../apps/backend/routes/concerts.route';

const app = express();
app.use(express.json());
app.use('/concerts', concerts_route);

describe('concerts route', () => {
  beforeEach(() => {
    mockGetConcertsPage.mockClear();
    mockGetConcertsCount.mockClear();
    mockGetConcertById.mockClear();
    mockGetConcertsPage.mockResolvedValue([]);
    mockGetConcertsCount.mockResolvedValue(0);
    mockGetConcertById.mockResolvedValue(null);
  });

  it('GET /concerts requires an Authorization header', async () => {
    const response = await request(app).get('/concerts');
    expect(response.status).toBe(401);
    expect(mockGetConcertsPage).not.toHaveBeenCalled();
  });

  it('GET /concerts serves an authenticated request', async () => {
    const response = await request(app).get('/concerts').set('Authorization', 'Bearer test-token');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      concerts: [],
      pagination: { page: 1, limit: 50, total: 0, hasMore: false },
    });
  });

  // BS#1694 — the whole point of the by-id route: a request WITHOUT any
  // Authorization header reaches the controller. The share page (a Cloudflare
  // Worker) and CDNs have no sane path to minting anonymous sessions.
  it('GET /concerts/:id serves a request with NO Authorization header', async () => {
    const concert = { id: 42 };
    mockGetConcertById.mockResolvedValue(concert);

    const response = await request(app).get('/concerts/42');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(concert);
    expect(mockGetConcertById).toHaveBeenCalledWith(42);
  });

  it('GET /concerts/:id does not disturb the list route (list still 401s bare)', async () => {
    mockGetConcertById.mockResolvedValue({ id: 7 });
    await request(app).get('/concerts/7');

    const bareList = await request(app).get('/concerts');
    expect(bareList.status).toBe(401);
    expect(mockGetConcertsPage).not.toHaveBeenCalled();
  });
});
