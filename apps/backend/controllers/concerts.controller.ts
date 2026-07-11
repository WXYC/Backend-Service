import { RequestHandler } from 'express';
import * as concertsService from '../services/concerts.service.js';
import WxycError from '../utils/error.js';

/**
 * `GET /concerts` — Touring Soon feed (BS#1603, touring-events Phase 2).
 *
 * Contract lives in `wxyc-shared/api.yaml` v1.15.0 (`ConcertsResponse`).
 * Pagination follows the spec's `PaginationParams` conventions: 1-indexed
 * `page`, `limit` capped at 100; the response carries a `PaginationInfo`
 * object alongside the concerts.
 */

export type ConcertsQueryParams = {
  curated?: string;
  from?: string;
  to?: string;
  page?: string;
  limit?: string;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isValidIsoDate = (value: string): boolean => ISO_DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(value));

/**
 * Today's calendar date where the venues are (America/New_York) — the
 * default `from`. `starts_on` is a venue-local date, so deriving "today"
 * from server-clock UTC would flip the window at 8 PM Eastern and
 * prematurely drop tonight's shows. `en-CA` formats as YYYY-MM-DD.
 */
const todayEastern = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

export const getConcerts: RequestHandler<object, unknown, object, ConcertsQueryParams> = async (req, res) => {
  const { query } = req;

  const page = parseInt(query.page ?? '1');
  const limit = parseInt(query.limit ?? String(DEFAULT_LIMIT));

  if (isNaN(page) || page < 1) {
    throw new WxycError('page must be a positive integer', 400);
  }
  if (isNaN(limit) || limit < 1) {
    throw new WxycError('limit must be a positive integer', 400);
  }
  if (limit > MAX_LIMIT) {
    throw new WxycError(`limit must be at most ${MAX_LIMIT}`, 400);
  }

  if (query.curated !== undefined && query.curated !== 'true' && query.curated !== 'false') {
    throw new WxycError('curated must be "true" or "false"', 400);
  }
  const curated = query.curated === 'true';

  const from = query.from ?? todayEastern();
  if (!isValidIsoDate(from)) {
    throw new WxycError('from must be a valid YYYY-MM-DD date', 400);
  }
  const to = query.to;
  if (to !== undefined && !isValidIsoDate(to)) {
    throw new WxycError('to must be a valid YYYY-MM-DD date', 400);
  }

  const offset = (page - 1) * limit;
  const filters = { from, to, curated };
  const [concerts, total] = await Promise.all([
    concertsService.getConcertsPage(filters, limit, offset),
    concertsService.getConcertsCount(filters),
  ]);

  res.status(200).json({
    concerts,
    pagination: {
      page,
      limit,
      total,
      hasMore: offset + concerts.length < total,
    },
  });
};
