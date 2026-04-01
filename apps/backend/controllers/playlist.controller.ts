/**
 * Playlist controller.
 *
 * GET /playlists/recentEntries — unauthenticated, returns the enriched
 * playlist in tubafrenzy's grouped format with artworkURL on playcuts.
 */
import { RequestHandler } from 'express';
import { getRecentEntries as getEntries, isConnected } from '../services/playlist-proxy.service.js';

/**
 * GET /playlists/recentEntries
 *
 * Query params:
 *   v — API version (ignored, for compatibility)
 *   n — number of playcut entries to return (default 50, clamped [1, 100])
 *
 * Returns the playlist grouped into `{playcuts, talksets, breakpoints}`.
 * Playcuts are enriched with `artworkURL` when album_metadata has a match.
 *
 * Cache-Control: public, max-age=30 (30 seconds).
 * Returns 503 if the SSE connection has not yet received its init event.
 */
export const getRecentEntries: RequestHandler = (req, res) => {
  if (!isConnected()) {
    res.status(503).json({ message: 'Playlist data not yet available' });
    return;
  }

  let n = Number(req.query.n);
  if (!Number.isFinite(n)) {
    n = 50;
  }
  n = Math.round(n);
  n = Math.max(1, Math.min(n, 100));

  const result = getEntries(n);

  res.set('Cache-Control', 'public, max-age=30');
  res.status(200).json(result);
};
