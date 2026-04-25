import { RequestHandler } from 'express';
import * as searchService from '../services/search.service.js';
import type { SearchParams } from '../services/search.service.js';

type SearchQueryParams = {
  q?: string;
  page?: string;
  limit?: string;
  sort?: string;
  order?: string;
};

const VALID_SORTS: SearchParams['sort'][] = ['date', 'artist', 'song', 'dj'];
const VALID_ORDERS: SearchParams['order'][] = ['asc', 'desc'];
const MAX_LIMIT = 100;

/** GET /flowsheet/search — search historical playlist entries. */
export const searchFlowsheetEndpoint: RequestHandler<object, unknown, unknown, SearchQueryParams> = async (
  req,
  res,
  next
) => {
  // q is optional. Missing or empty q returns the most recent track entries
  // — the "show recent" default for the playlists landing page. The search
  // service treats an empty query as no WHERE filter beyond entry_type='track'.
  const q = req.query.q ?? '';

  const page = parseInt(req.query.page ?? '0');
  if (isNaN(page) || page < 0) {
    res.status(400).json({ message: 'page must be a non-negative number' });
    return;
  }

  const limit = parseInt(req.query.limit ?? '50');
  if (isNaN(limit) || limit < 1) {
    res.status(400).json({ message: 'limit must be a positive number' });
    return;
  }
  if (limit > MAX_LIMIT) {
    res.status(400).json({ message: `limit must not exceed ${MAX_LIMIT}` });
    return;
  }

  const sort = (
    VALID_SORTS.includes(req.query.sort as SearchParams['sort']) ? req.query.sort : 'date'
  ) as SearchParams['sort'];

  const order = (
    VALID_ORDERS.includes(req.query.order as SearchParams['order']) ? req.query.order : 'desc'
  ) as SearchParams['order'];

  try {
    const { results, total } = await searchService.searchFlowsheet({ q, page, limit, sort, order });
    const totalPages = Math.ceil(total / limit);

    res.status(200).json({ results, total, page, totalPages });
  } catch (e) {
    console.error('Error searching flowsheet');
    console.error(e);
    next(e);
  }
};
