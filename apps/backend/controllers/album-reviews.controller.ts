import { RequestHandler } from 'express';
import * as albumReviewsService from '../services/album-reviews.service.js';
import WxycError from '../utils/error.js';

/**
 * `GET /album-reviews` — form-review archive read (ADR 0011 / the
 * dj-reviews-internal-surface plan).
 *
 * INTERNAL surface, gated on `reviews: ['read']` (dj / musicDirector /
 * stationManager) at `routes/album-reviews.route.ts`. It serves the whole
 * archive with no `social_consent` filter; the consent-gated PUBLIC surface is
 * the `wxycReviews` attach on `GET /proxy/metadata/album`. See ADR 0011 for
 * why the two postures must not be conflated.
 *
 * Contract lives in `wxyc-shared/api.yaml` (`AlbumReviewsResponse`).
 * Pagination follows the spec's `PaginationParams` conventions: 1-indexed
 * `page`, `limit` capped at 100; the response carries a `PaginationInfo`
 * object alongside the `album_reviews`. Reviewer identity never appears in
 * responses — the service's projection is the PII barrier (see
 * album-reviews.service.ts).
 */

export type AlbumReviewsQueryParams = {
  album_id?: string;
  artist?: string;
  page?: string;
  limit?: string;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_ARTIST_LENGTH = 256;

/**
 * Parse a positive-integer query param behind an all-digits guard. A bare
 * `parseInt` would accept '1abc' → 1 and '0x10' → 16; requiring the raw
 * value to be all digits (and using an explicit radix) rejects both.
 * Returns 400 on malformed input via `WxycError`.
 */
const parsePositiveInt = (raw: string, field: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new WxycError(`${field} must be a positive integer`, 400);
  }
  return Number.parseInt(raw, 10);
};

export const getAlbumReviews: RequestHandler<object, unknown, object, AlbumReviewsQueryParams> = async (req, res) => {
  const { query } = req;

  const page = parsePositiveInt(query.page ?? '1', 'page');
  const limit = parsePositiveInt(query.limit ?? String(DEFAULT_LIMIT), 'limit');

  if (page < 1) {
    throw new WxycError('page must be a positive integer', 400);
  }
  if (limit < 1) {
    throw new WxycError('limit must be a positive integer', 400);
  }
  if (limit > MAX_LIMIT) {
    throw new WxycError(`limit must be at most ${MAX_LIMIT}`, 400);
  }

  let album_id: number | undefined;
  if (query.album_id !== undefined) {
    album_id = parsePositiveInt(query.album_id, 'album_id');
    if (album_id < 1) {
      throw new WxycError('album_id must be a positive integer', 400);
    }
  }

  let artist: string | undefined;
  if (query.artist !== undefined) {
    // The typeof guard matters: Express's query parser turns a repeated
    // param (?artist=a&artist=b) into an array despite the declared type,
    // and an array must 400 here rather than reach the service's
    // normalize call.
    if (typeof query.artist !== 'string' || query.artist.trim() === '') {
      throw new WxycError('artist must be a non-empty string', 400);
    }
    if (query.artist.length > MAX_ARTIST_LENGTH) {
      throw new WxycError(`artist must be at most ${MAX_ARTIST_LENGTH} characters`, 400);
    }
    artist = query.artist;
  }

  const offset = (page - 1) * limit;
  const filters = { album_id, artist };
  const [album_reviews, total] = await Promise.all([
    albumReviewsService.getAlbumReviewsPage(filters, limit, offset),
    albumReviewsService.getAlbumReviewsCount(filters),
  ]);

  res.status(200).json({
    album_reviews,
    pagination: {
      page,
      limit,
      total,
      hasMore: offset + album_reviews.length < total,
    },
  });
};
