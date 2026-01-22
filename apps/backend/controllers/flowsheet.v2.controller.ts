import { RequestHandler } from 'express';
import * as flowsheet_service from '../services/flowsheet.service.js';

/**
 * GET /v2/flowsheet/playlist
 * Get show info with entries in discriminated union format
 */
export const getShowInfo: RequestHandler<object, unknown, object, { show_id: string }> = async (req, res, next) => {
  const showId = parseInt(req.query.show_id);

  if (isNaN(showId)) {
    res.status(400).json({ message: 'Missing or invalid show_id parameter' });
    return;
  }

  try {
    const showInfo = await flowsheet_service.getPlaylist(showId);

    // Transform entries to V2 discriminated union format
    const v2Entries = showInfo.entries.map((entry) =>
      flowsheet_service.transformToV2(entry as Parameters<typeof flowsheet_service.transformToV2>[0])
    );

    res.status(200).json({
      ...showInfo,
      entries: v2Entries,
    });
  } catch (e) {
    console.error('Error: Failed to retrieve playlist');
    console.error(e);
    next(e);
  }
};
