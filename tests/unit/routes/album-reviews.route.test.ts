/**
 * Route-wiring tests for /album-reviews (album-reviews-sheet-sync plan /
 * ADR 0011).
 *
 * The @wxyc/authentication mock's `requirePermissions` returns 401 when the
 * Authorization header is missing, so these pin that the route group is
 * actually mounted behind the middleware (anonymous session auth — any
 * bearer token, no permission scope — matching the /concerts and /proxy
 * read surfaces).
 */
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockGetAlbumReviewsPage = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
const mockGetAlbumReviewsCount = jest.fn<() => Promise<number>>().mockResolvedValue(0);

jest.mock('../../../apps/backend/services/album-reviews.service', () => ({
  getAlbumReviewsPage: mockGetAlbumReviewsPage,
  getAlbumReviewsCount: mockGetAlbumReviewsCount,
}));

import { album_reviews_route } from '../../../apps/backend/routes/album-reviews.route';

const app = express();
app.use(express.json());
app.use('/album-reviews', album_reviews_route);

describe('album-reviews route', () => {
  beforeEach(() => {
    mockGetAlbumReviewsPage.mockClear();
    mockGetAlbumReviewsCount.mockClear();
    mockGetAlbumReviewsPage.mockResolvedValue([]);
    mockGetAlbumReviewsCount.mockResolvedValue(0);
  });

  it('GET /album-reviews requires an Authorization header', async () => {
    const response = await request(app).get('/album-reviews');
    expect(response.status).toBe(401);
    expect(mockGetAlbumReviewsPage).not.toHaveBeenCalled();
  });

  it('GET /album-reviews serves an authenticated request', async () => {
    const response = await request(app).get('/album-reviews').set('Authorization', 'Bearer test-token');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      album_reviews: [],
      pagination: { page: 1, limit: 50, total: 0, hasMore: false },
    });
  });
});
