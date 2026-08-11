/**
 * Playlist controller.
 *
 * GET /playlists/recentEntries — unauthenticated. Serves both legacy
 * tubafrenzy wire formats: the v=2 grouped object (iOS) and the v=1 flat
 * array (Android). See playlist-proxy.service.ts.
 */
import { RequestHandler } from 'express';
import {
  getRecentEntries as getGrouped,
  getRecentEntriesFlat as getFlat,
  lastModifiedFromTimestamps,
} from '../services/playlist-proxy.service.js';

// v=2 grouped (iOS): playcuts sliced to n from a 200-row window.
const DEFAULT_GROUPED_N = 50;
const MAX_GROUPED_N = 100;
// v=1 flat (Android): n bounds TOTAL entries, matching tubafrenzy's
// getNRecentFlowsheetEntries(n) and its 200-entry cache cap / default.
const DEFAULT_FLAT_N = 200;
const MAX_FLAT_N = 200;

function parseN(raw: unknown, def: number, max: number): number {
  let n = Number(raw);
  if (!Number.isFinite(n)) {
    n = def;
  }
  n = Math.round(n);
  return Math.max(1, Math.min(n, max));
}

/**
 * GET /playlists/recentEntries
 *
 * Query params:
 *   v — wire-format version. `v=2` → grouped `{playcuts, talksets,
 *       breakpoints}` (iOS). Absent or any other value → v=1 flat array
 *       (Android's contract — Android sends no `v`). BS#1866.
 *   n — entry count. v=2: playcuts returned (default 50, clamped [1, 100]).
 *       v=1: total entries returned (default 200, clamped [1, 200]).
 *
 * Queried live from Postgres (Phase 3 of the tubafrenzy decommission,
 * WXYC/wiki#88). v=2 playcuts are enriched with `artworkURL` plus, since
 * BS#2103, the full `/flowsheet` metadata set (streaming links, bio,
 * genres/styles, release year, artist id, upcoming show, critic reviews)
 * under the camelCase keys shipped iOS 3.2 decodes — see
 * playlist-proxy.service.ts. v=1 carries none of it (tubafrenzy's v=1 never
 * carried artwork either — Android resolves its own).
 *
 * Headers:
 *   Cache-Control: public, max-age=30
 *   X-Last-Modified: max entry `timeCreated` in the served window (BS#1866),
 *     exposed via Access-Control-Expose-Headers for the browser page's
 *     conditional-fetch parity.
 *
 * A DB failure is caught here and written as a DIRECT 503 response — it must
 * not be thrown into the error pipeline, because `sentryErrorFilter` captures
 * every >=500 and this unauthenticated endpoint is polled on a fixed interval
 * by every mobile client, so a transient DB blip would emit one Sentry event
 * per poll (the catalog-search 503 flood pattern). A 503 (not 500) so clients
 * read it as "try again shortly".
 */
export const getRecentEntries: RequestHandler = async (req, res) => {
  // Only a plain `?v=2` string selects the grouped shape; anything else
  // (absent, v=1, an array/object from a malformed query) is the v=1 default.
  const versionParam = req.query.v;
  const grouped = (typeof versionParam === 'string' ? versionParam : '') === '2';
  const n = grouped
    ? parseN(req.query.n, DEFAULT_GROUPED_N, MAX_GROUPED_N)
    : parseN(req.query.n, DEFAULT_FLAT_N, MAX_FLAT_N);

  let payload: unknown;
  let lastModified: number;
  try {
    if (grouped) {
      const result = await getGrouped(n);
      lastModified = lastModifiedFromTimestamps([
        ...result.playcuts.map((p) => p.timeCreated),
        ...result.talksets.map((t) => t.timeCreated),
        ...result.breakpoints.map((b) => b.timeCreated),
      ]);
      payload = result;
    } else {
      const entries = await getFlat(n);
      lastModified = lastModifiedFromTimestamps(entries.map((e) => e.timeCreated));
      payload = entries;
    }
  } catch (err) {
    console.error('[playlist] Failed to fetch recent entries:', err);
    res.status(503).json({ message: 'Playlist data temporarily unavailable' });
    return;
  }

  res.set('Cache-Control', 'public, max-age=30');
  res.set('X-Last-Modified', String(lastModified));
  // Append, not set: the global CORS middleware already exposes X-Request-Id
  // (app.ts), and res.set would clobber it. res.append preserves both.
  res.append('Access-Control-Expose-Headers', 'X-Last-Modified');
  res.status(200).json(payload);
};
