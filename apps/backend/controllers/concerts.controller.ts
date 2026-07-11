import { RequestHandler } from 'express';
import { nyCalendarDate } from '@wxyc/database';
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

/**
 * Strict `YYYY-MM-DD` calendar-date validation. A shape check plus
 * `Date.parse` is not enough: `Date.parse` rolls invalid days forward
 * ('2026-02-30' parses as 2026-03-02, '2026-04-31' as 2026-05-01), so a
 * bad-but-shaped date would pass validation, reach the Postgres `date`
 * bind, be rejected there, and surface as an unhandled 500 instead of a
 * 400. Round-tripping the parsed instant back through `toISOString()` and
 * comparing the calendar portion rejects any rolled-over date: only a real
 * calendar day formats back to the exact same string.
 */
const isValidIsoDate = (value: string): boolean => {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/**
 * Today's calendar date where the venues are (America/New_York) — the
 * default `from`. `starts_on` is a venue-local date, so deriving "today"
 * from server-clock UTC would flip the window at 8 PM Eastern and
 * prematurely drop tonight's shows. Delegates to the shared `nyCalendarDate`
 * helper (`@wxyc/database`), which the concert writers already use and which
 * carries a full-ICU guard the inline `Intl` copy lacked.
 */
const todayEastern = (): string => nyCalendarDate(new Date());

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

export const getConcerts: RequestHandler<object, unknown, object, ConcertsQueryParams> = async (req, res) => {
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
