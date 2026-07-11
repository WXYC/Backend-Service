/**
 * Route-wiring tests for /concerts (BS#1603).
 *
 * The @wxyc/authentication mock's `requirePermissions` returns 401 when the
 * Authorization header is missing, so these pin that the route group is
 * actually mounted behind the middleware (anonymous session auth — any
 * bearer token, no permission scope — matching the /proxy read surfaces).
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockGetConcertsPage = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
const mockGetConcertsCount = jest.fn<() => Promise<number>>().mockResolvedValue(0);

jest.mock('../../../apps/backend/services/concerts.service', () => ({
  getConcertsPage: mockGetConcertsPage,
  getConcertsCount: mockGetConcertsCount,
}));

import { concerts_route } from '../../../apps/backend/routes/concerts.route';

const app = express();
app.use(express.json());
app.use('/concerts', concerts_route);

describe('concerts route', () => {
  beforeEach(() => {
    mockGetConcertsPage.mockClear();
    mockGetConcertsCount.mockClear();
    mockGetConcertsPage.mockResolvedValue([]);
    mockGetConcertsCount.mockResolvedValue(0);
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
});
