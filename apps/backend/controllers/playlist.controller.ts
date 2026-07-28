/**
 * Playlist controller.
 *
 * GET /playlists/recentEntries — unauthenticated, returns the enriched
 * playlist in tubafrenzy's grouped format with artworkURL on playcuts.
 */
import { RequestHandler } from 'express';
import WxycError from '../utils/error.js';
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
 * A DB failure is caught here and surfaced as a 503 (via the shared
 * `errorHandler` middleware) rather than a 500: this is an unauthenticated
 * endpoint mobile clients poll on a fixed interval, so a transient DB hiccup
 * should read as "try again shortly", not a hard failure. Mirrors the
 * pre-Phase-3 503 this endpoint already returned while the SSE connection
 * hadn't received its init event yet.
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
    throw new WxycError('Playlist data temporarily unavailable', 503);
  }

  res.set('Cache-Control', 'public, max-age=30');
  res.status(200).json(result);
};
