/**
 * Playlist controller.
 *
 * GET /playlists/recentEntries — unauthenticated, returns the enriched
 * playlist in tubafrenzy's grouped format with artworkURL on playcuts.
 */
import { RequestHandler } from 'express';
import { getRecentEntries as getEntries } from '../services/playlist-proxy.service.js';

/**
 * GET /playlists/recentEntries
 *
 * Query params:
 *   v — API version (ignored, for compatibility)
 *   n — number of playcut entries to return (default 50, clamped [1, 100])
 *
 * Returns the playlist grouped into `{playcuts, talksets, breakpoints}`,
 * queried live from Postgres (Phase 3 of the tubafrenzy decommission,
 * WXYC/wiki#88 — see playlist-proxy.service.ts). Playcuts are enriched with
 * `artworkURL` when album_metadata has a match.
 *
 * Cache-Control: public, max-age=30 (30 seconds).
 *
 * A DB failure is caught here and written as a DIRECT 503 response — it must
 * not be thrown into the error pipeline, because `sentryErrorFilter` captures
 * every >=500 and this unauthenticated endpoint is polled on a fixed interval
 * by every mobile client, so a transient DB blip would emit one Sentry event
 * per poll (the catalog-search 503 flood pattern). The direct write mirrors
 * the pre-Phase-3 code, which returned its "SSE not ready" 503 the same way,
 * uncaptured. A 503 (not 500) so clients read it as "try again shortly".
 */
export const getRecentEntries: RequestHandler = async (req, res) => {
  let n = Number(req.query.n);
  if (!Number.isFinite(n)) {
    n = 50;
  }
  n = Math.round(n);
  n = Math.max(1, Math.min(n, 100));

  let result;
  try {
    result = await getEntries(n);
  } catch (err) {
    console.error('[playlist] Failed to fetch recent entries:', err);
    res.status(503).json({ message: 'Playlist data temporarily unavailable' });
    return;
  }

  res.set('Cache-Control', 'public, max-age=30');
  res.status(200).json(result);
};
