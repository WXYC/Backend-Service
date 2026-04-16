import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db, flowsheet, shows } from '@wxyc/database';
import { serverEventsMgr, Topics, FsEvents } from '../utils/serverEvents.js';
import { updateLastModified } from '../services/flowsheet.service.js';
import { mapProdEntryType, truncate } from '../utils/flowsheet-transform.js';

const ETL_NOTIFY_KEY = process.env.ETL_NOTIFY_KEY ?? '';

export const internal_route = Router();

/**
 * Authenticate internal requests via a shared secret in the X-Internal-Key header.
 * Used by the ETL and tubafrenzy webhook.
 */
function authenticateInternal(key: string | undefined): boolean {
  return !!ETL_NOTIFY_KEY && key === ETL_NOTIFY_KEY;
}

/**
 * POST /internal/flowsheet-sync-notify
 *
 * Called by the flowsheet ETL after importing new or updated entries from
 * tubafrenzy. Broadcasts a refetch event to all SSE clients subscribed to
 * the liveFs topic so dj-site UIs stay in sync.
 */
internal_route.post('/flowsheet-sync-notify', (req, res) => {
  if (!authenticateInternal(req.get('X-Internal-Key'))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  serverEventsMgr.broadcast(Topics.liveFs, {
    type: FsEvents.refetch,
    payload: { source: 'etl' },
  });

  res.json({ ok: true });
});

/**
 * Look up a show by legacy_show_id, creating a stub if it doesn't exist.
 * Uses onConflictDoNothing + re-select for concurrent-insert safety.
 */
async function resolveShowId(legacyShowId: number): Promise<number | null> {
  if (!legacyShowId) return null;

  const existing = await db.select({ id: shows.id }).from(shows).where(eq(shows.legacy_show_id, legacyShowId)).limit(1);
  if (existing.length > 0) return existing[0].id;

  // Create a stub show — the ETL will fill in details (end_time, show_name) later.
  await db.insert(shows).values({ legacy_show_id: legacyShowId, start_time: new Date() }).onConflictDoNothing();

  const [row] = await db.select({ id: shows.id }).from(shows).where(eq(shows.legacy_show_id, legacyShowId)).limit(1);
  return row?.id ?? null;
}

const VALID_ACTIONS = new Set(['create', 'update', 'delete']);

/**
 * POST /internal/flowsheet-webhook
 *
 * Receives flowsheet entry events from tubafrenzy. Called by tubafrenzy's
 * WebhookFlowsheetEntryListener when entries are created, updated, or deleted.
 *
 * Payload:
 *   { action: "create"|"update", entry: { id, radioShowId, flowsheetEntryType, ... } }
 *   { action: "delete", entryId: number }
 */
internal_route.post('/flowsheet-webhook', async (req, res) => {
  if (!authenticateInternal(req.get('X-Internal-Key'))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { action, entry, entryId } = req.body ?? {};

  if (!action || !VALID_ACTIONS.has(action)) {
    res.status(400).json({ error: 'Missing or invalid action. Expected: create, update, or delete.' });
    return;
  }

  try {
    if (action === 'delete') {
      if (typeof entryId !== 'number') {
        res.status(400).json({ error: 'Missing entryId for delete action.' });
        return;
      }
      await db.delete(flowsheet).where(eq(flowsheet.legacy_entry_id, entryId));
    } else {
      // create or update — both use upsert
      if (!entry || typeof entry.id !== 'number') {
        res.status(400).json({ error: 'Missing entry.id for create/update action.' });
        return;
      }

      const entryType = mapProdEntryType(entry.flowsheetEntryType ?? 0);
      const showId = await resolveShowId(entry.radioShowId);

      await db
        .insert(flowsheet)
        .values({
          legacy_entry_id: entry.id,
          show_id: showId,
          entry_type: entryType,
          artist_name: truncate(entry.artistName, 128),
          album_title: truncate(entry.releaseTitle, 128),
          track_title: truncate(entry.songTitle, 128),
          record_label: truncate(entry.labelName, 128),
          request_flag: !!entry.requestFlag,
          segue: false,
          play_order: entry.sequenceWithinShow ?? 0,
          add_time: entry.startTime ? new Date(entry.startTime) : new Date(),
        })
        .onConflictDoUpdate({
          target: flowsheet.legacy_entry_id,
          set: {
            artist_name: sql`excluded.artist_name`,
            album_title: sql`excluded.album_title`,
            track_title: sql`excluded.track_title`,
            record_label: sql`excluded.record_label`,
            request_flag: sql`excluded.request_flag`,
            entry_type: sql`excluded.entry_type`,
          },
        });
    }

    updateLastModified();
    serverEventsMgr.broadcast(Topics.liveFs, {
      type: FsEvents.refetch,
      payload: { source: 'webhook' },
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook] Flowsheet webhook error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
