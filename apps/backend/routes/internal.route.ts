import { Router } from 'express';
import { serverEventsMgr, Topics, FsEvents } from '../utils/serverEvents.js';

const ETL_NOTIFY_KEY = process.env.ETL_NOTIFY_KEY ?? '';

export const internal_route = Router();

/**
 * POST /internal/flowsheet-sync-notify
 *
 * Called by the flowsheet ETL after importing new or updated entries from
 * tubafrenzy. Broadcasts a refetch event to all SSE clients subscribed to
 * the liveFs topic so dj-site UIs stay in sync.
 *
 * Authenticated via a shared secret in the X-Internal-Key header.
 */
internal_route.post('/flowsheet-sync-notify', (req, res) => {
  const key = req.get('X-Internal-Key');
  if (!ETL_NOTIFY_KEY || key !== ETL_NOTIFY_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  serverEventsMgr.broadcast(Topics.liveFs, {
    type: FsEvents.refetch,
    payload: { source: 'etl' },
  });

  res.json({ ok: true });
});
