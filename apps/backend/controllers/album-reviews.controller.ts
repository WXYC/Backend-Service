import { RequestHandler } from 'express';
import * as albumReviewsService from '../services/album-reviews.service.js';
import WxycError from '../utils/error.js';
import { parsePositiveInt } from '../utils/query-params.js';
import type { AlbumReviewsResponse } from '@wxyc/shared/dtos';

/**
 * `GET /album-reviews` — form-review archive read (ADR 0011 / the
 * dj-reviews-internal-surface plan).
 *
 * Gate and consent posture: `routes/album-reviews.route.ts`, where the
 * argument lives once. PII barrier: `services/album-reviews.service.ts`. This
 * file owns only param validation and the response envelope — the posture
 * paragraph was restated in three files one import apart, and it is a posture
 * that has already inverted once (PR #1679 shipped it as anonymous-auth), so
 * each copy is a place a future reversal has to be chased.
 *
 * Contract lives in `wxyc-shared/api.yaml` (`AlbumReviewsResponse`).
 * Pagination follows the spec's `PaginationParams` conventions: 1-indexed
 * `page`, `limit` capped at 100; the response carries a `PaginationInfo`
 * object alongside the `album_reviews`.
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

export const getAlbumReviews: RequestHandler<object, unknown, object, AlbumReviewsQueryParams> = async (req, res) => {
  const { query } = req;

  const page = parsePositiveInt(query.page ?? '1', 'page');
  const limit = parsePositiveInt(query.limit ?? String(DEFAULT_LIMIT), 'limit');

  if (limit > MAX_LIMIT) {
    throw new WxycError(`limit must be at most ${MAX_LIMIT}`, 400);
  }

  const album_id = query.album_id === undefined ? undefined : parsePositiveInt(query.album_id, 'album_id');

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

  // Typed as the SSOT envelope rather than an inline literal, so a drift in
  // `AlbumReviewsResponse` is a build error here. This is deliberately in the
  // controller and not a `Expect<Equal<...>>` pin in the unit test: `npm run
  // typecheck` covers `apps/**` and `shared/**` but NOT `tests/`, and ts-jest
  // runs transpile-only, so a type-level assertion living in a test file is
  // checked by nothing. (The same is true of the `ConcertDTO`/`ApiYamlConcert`
  // pin in `tests/unit/services/concerts.service.test.ts` — worth its own
  // pass; do not add a third.)
  const body: AlbumReviewsResponse = {
    album_reviews,
    pagination: {
      page,
      limit,
      total,
      hasMore: offset + album_reviews.length < total,
    },
  };

  res.status(200).json(body);
};
