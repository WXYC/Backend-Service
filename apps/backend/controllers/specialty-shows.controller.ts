import { RequestHandler } from 'express';
import * as specialtyShowsService from '../services/specialty-shows.service.js';

/**
 * Public `GET /specialty-shows` (BS#3453): the active catalog, cacheable for five minutes and revalidated by a strong
 * ETag derived from max(last_modified) over the whole table. The ETag is set before `res.json` so Express never
 * generates its own weak per-body validator. An empty table has no watermark, so it carries no ETag.
 */
export const getSpecialtyShows: RequestHandler = async (req, res) => {
  const [shows, lastModified] = await Promise.all([
    specialtyShowsService.getActiveSpecialtyShows(),
    specialtyShowsService.getCatalogLastModified(),
  ]);

  res.set('Cache-Control', 'public, max-age=300');

  if (lastModified !== null) {
    const etag = `"${lastModified.getTime()}"`;
    res.set('ETag', etag);

    const candidates = (req.get('If-None-Match') ?? '').split(',').map((tag) => tag.trim().replace(/^W\//, ''));
    if (candidates.includes(etag) || candidates.includes('*')) {
      res.status(304).end();
      return;
    }
  }

  res.status(200).json(shows);
};
