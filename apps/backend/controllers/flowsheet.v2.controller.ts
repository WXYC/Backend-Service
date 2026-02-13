import { RequestHandler } from 'express';
import * as flowsheet_service from '../services/flowsheet.service.js';

type PaginationQuery = {
  page?: string;
  limit?: string;
};

const MAX_ITEMS = 200;

/**
 * GET /v2/flowsheet/
 * Paginated flowsheet entries in V2 discriminated union format.
 */
export const getEntries: RequestHandler<object, unknown, object, PaginationQuery> = async (req, res, next) => {
  const page = parseInt(req.query.page ?? '0');
  const limit = parseInt(req.query.limit ?? '30');

  if (isNaN(limit) || limit < 1) {
    res.status(400).json({ message: 'limit must be a positive number' });
    return;
  }

  if (limit > MAX_ITEMS) {
    res.status(400).json({ message: 'Requested too many entries' });
    return;
  }

  if (isNaN(page) || page < 0) {
    res.status(400).json({ message: 'page must be a non-negative number' });
    return;
  }

  try {
    const offset = page * limit;
    const [entries, total] = await Promise.all([
      flowsheet_service.getEntriesByPage(offset, limit),
      flowsheet_service.getEntryCount(),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.status(200).json({
      entries: entries.map(flowsheet_service.transformToV2),
      total,
      page,
      limit,
      totalPages,
    });
  } catch (e) {
    console.error('Error: Failed to retrieve V2 flowsheet entries');
    console.error(e);
    next(e);
  }
};

/**
 * GET /v2/flowsheet/latest
 * Single latest flowsheet entry in V2 discriminated union format.
 */
export const getLatest: RequestHandler = async (req, res, next) => {
  try {
    const entries = await flowsheet_service.getEntriesByPage(0, 1);
    if (entries.length) {
      res.status(200).json(flowsheet_service.transformToV2(entries[0]));
    } else {
      res.status(404).json({ message: 'No entries found' });
    }
  } catch (e) {
    console.error('Error: Failed to retrieve latest V2 flowsheet entry');
    console.error(e);
    next(e);
  }
};

/**
 * GET /v2/flowsheet/playlist
 * Show info with entries in V2 discriminated union format.
 */
export const getShowInfo: RequestHandler<object, unknown, object, { show_id: string }> = async (req, res, next) => {
  const showId = parseInt(req.query.show_id);

  if (isNaN(showId)) {
    res.status(400).json({ message: 'Missing or invalid show_id parameter' });
    return;
  }

  try {
    const [showMetadata, ifsEntries] = await Promise.all([
      flowsheet_service.getShowMetadata(showId),
      flowsheet_service.getEntriesByShow(showId),
    ]);

    res.status(200).json({
      ...showMetadata,
      entries: ifsEntries.map(flowsheet_service.transformToV2),
    });
  } catch (e) {
    console.error('Error: Failed to retrieve playlist');
    console.error(e);
    next(e);
  }
};
