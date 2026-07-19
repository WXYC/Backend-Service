import { RequestHandler } from 'express';
import { nyCalendarDate } from '@wxyc/database';
import * as concertsService from '../services/concerts.service.js';
import WxycError from '../utils/error.js';

/**
 * `GET /concerts` — On Tour feed (BS#1603, on-tour Phase 2).
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
 * Parse a positive-integer param behind an all-digits guard. A bare
 * `parseInt` would accept '1abc' → 1 and '0x10' → 16; requiring the raw
 * value to be all digits (and using an explicit radix) rejects both. The
 * `< 1` rejection makes the name honest — '0' is all-digits but not
 * positive — so callers need no follow-up check. Returns 400 on malformed
 * input via `WxycError`.
 */
const parsePositiveInt = (raw: string, field: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw new WxycError(`${field} must be a positive integer`, 400);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1) {
    throw new WxycError(`${field} must be a positive integer`, 400);
  }
  return parsed;
};

export const getConcerts: RequestHandler<object, unknown, object, ConcertsQueryParams> = async (req, res) => {
  const { query } = req;

  const page = parsePositiveInt(query.page ?? '1', 'page');
  const limit = parsePositiveInt(query.limit ?? String(DEFAULT_LIMIT), 'limit');

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

/**
 * `GET /concerts/:id` — public single-concert read (BS#1694, On Tour
 * sharing). Contract: `wxyc-shared/api.yaml` v1.18.0 (`/concerts/{id}`,
 * wxyc-shared#236) — no authentication (the route registers this handler
 * with no middleware; see concerts.route.ts), no date window, tombstoned
 * rows served with the `status` they last carried, 404 only for ids with no
 * row.
 *
 * The id runs through the same all-digits/positive guard as the list's
 * page/limit (a bare parseInt would accept '12abc') — 400 before any query.
 * Ids that pass the guard but cannot exist for an int4 serial (beyond
 * 2^31-1) resolve to null in the service, which owns that persistence fact,
 * and surface as the same 404 as any other miss.
 *
 * Caching: every response starts pinned `Cache-Control: no-store`; only the
 * 200 path upgrades to `public, max-age=300` (the playlist proxy's
 * public-cache pattern at the spec's ~5-minute TTL — no per-session
 * variance, so the share Worker and CDNs absorb share-spike traffic).
 * Omitting the header on errors would NOT keep them out of shared caches:
 * 404 is heuristically cacheable by default (RFC 9110 §15.5.5), and concert
 * ids are predictable serials, so a header-less 404 could pin a
 * freshly-shared id as dead at the edge for the CDN's default error TTL.
 */
export const getConcertById: RequestHandler<{ id: string }> = async (req, res) => {
  res.set('Cache-Control', 'no-store');

  const id = parsePositiveInt(req.params.id, 'id');

  const concert = await concertsService.getConcertById(id);
  if (concert === null) {
    throw new WxycError(`No concert with id ${id}`, 404);
  }

  res.set('Cache-Control', 'public, max-age=300');
  res.status(200).json(concert);
};
