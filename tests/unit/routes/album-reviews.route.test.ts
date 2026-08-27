/**
 * Route-wiring tests for /album-reviews (ADR 0011 / the
 * dj-reviews-internal-surface plan).
 *
 * These pin MOUNTING ONLY. `jest.unit.config.ts` maps `@wxyc/authentication`
 * to `tests/mocks/authentication.mock.ts`, whose `requirePermissions(_required)`
 * ignores its argument and only checks for an Authorization header — so this
 * file can prove the router sits behind the middleware, and can prove NOTHING
 * about which roles that middleware admits. It would stay green if the gate
 * were silently relaxed to `requirePermissions({})`.
 *
 * The gate itself is pinned in `tests/unit/routes/album-reviews-permissions.route.test.ts`,
 * which wires the REAL middleware back in and injects a role.
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
