import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db, flowsheet, shows, rotation, library, truncate } from '@wxyc/database';
import { serverEventsMgr, Topics, FsEvents } from '../utils/serverEvents.js';
import { updateLastModified } from '../services/flowsheet.service.js';
import { mapProdEntryType, isMessageEntryType } from '../utils/flowsheet-transform.js';

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
      const isMsgType = isMessageEntryType(entryType);

      await db
        .insert(flowsheet)
        .values({
          legacy_entry_id: entry.id,
          show_id: showId,
          entry_type: entryType,
          artist_name: isMsgType ? null : truncate(entry.artistName, 128),
          album_title: truncate(entry.releaseTitle, 128),
          track_title: truncate(entry.songTitle, 128),
          record_label: truncate(entry.labelName, 128),
          message: isMsgType ? truncate(entry.artistName, 250) : null,
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
            message: sql`excluded.message`,
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

// ---- Rotation Endpoints ----

/**
 * POST /internal/rotation-sync-notify
 *
 * Called by the rotation ETL after importing new or updated rotation releases
 * from tubafrenzy. Broadcasts a refetch event so dj-site UIs stay in sync.
 */
internal_route.post('/rotation-sync-notify', (req, res) => {
  if (!authenticateInternal(req.get('X-Internal-Key'))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  serverEventsMgr.broadcast(Topics.liveFs, {
    type: FsEvents.refetch,
    payload: { source: 'rotation-etl' },
  });

  res.json({ ok: true });
});

/**
 * POST /internal/artist-identity-sync-notify
 *
 * Called by the artist-identity ETL after copying reconciled external IDs
 * from LML's `entity.identity` table. No SSE consumer exists today (the
 * library views are read-on-demand), so this handler exists only to keep
 * the polling-mode notify call from logging 404s. It still authenticates
 * so a future SSE topic can be added without changing the contract.
 */
internal_route.post('/artist-identity-sync-notify', (req, res) => {
  if (!authenticateInternal(req.get('X-Internal-Key'))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  res.json({ ok: true });
});

const VALID_ROTATION_ACTIONS = new Set(['create', 'update', 'kill', 'unkill']);
const VALID_ROTATION_BINS = new Set(['S', 'L', 'M', 'H', 'N']);

/**
 * Resolve a Backend-Service album_id from a tubafrenzy LIBRARY_RELEASE_ID.
 * Returns null if the library release ID is 0 or not found.
 */
async function resolveAlbumId(legacyLibraryReleaseId: number): Promise<number | null> {
  if (!legacyLibraryReleaseId) return null;

  const [row] = await db
    .select({ id: library.id })
    .from(library)
    .where(eq(library.legacy_release_id, legacyLibraryReleaseId))
    .limit(1);
  return row?.id ?? null;
}

/**
 * POST /internal/rotation-webhook
 *
 * Receives rotation release events from tubafrenzy. Called by tubafrenzy's
 * WebhookRotationReleaseListener when releases are added, updated, killed, or unkilled.
 *
 * Payload:
 *   { action: "create"|"update", release: { id, artistName, albumTitle, rotationType, labelName, addDate, killDate, libraryReleaseId } }
 *   { action: "kill", release: { id, killDate } }
 *   { action: "unkill", releaseId: number }
 */
internal_route.post('/rotation-webhook', async (req, res) => {
  if (!authenticateInternal(req.get('X-Internal-Key'))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { action, release, releaseId } = req.body ?? {};

  if (!action || !VALID_ROTATION_ACTIONS.has(action)) {
    res.status(400).json({ error: 'Missing or invalid action. Expected: create, update, kill, or unkill.' });
    return;
  }

  try {
    if (action === 'unkill') {
      if (typeof releaseId !== 'number') {
        res.status(400).json({ error: 'Missing releaseId for unkill action.' });
        return;
      }
      await db.update(rotation).set({ kill_date: null }).where(eq(rotation.legacy_rotation_id, releaseId));
    } else if (action === 'kill') {
      if (!release || typeof release.id !== 'number') {
        res.status(400).json({ error: 'Missing release.id for kill action.' });
        return;
      }
      const killDate =
        release.killDate && release.killDate !== 0
          ? new Date(release.killDate).toISOString().split('T')[0]
          : new Date().toISOString().split('T')[0];
      await db.update(rotation).set({ kill_date: killDate }).where(eq(rotation.legacy_rotation_id, release.id));
    } else {
      // create or update — both use upsert
      if (!release || typeof release.id !== 'number') {
        res.status(400).json({ error: 'Missing release.id for create/update action.' });
        return;
      }

      const rotationType = VALID_ROTATION_BINS.has(release.rotationType) ? release.rotationType : 'N';
      const rawLibraryId = release.libraryReleaseId ?? 0;
      const albumId = await resolveAlbumId(rawLibraryId);
      const addDate =
        release.addDate && release.addDate !== 0
          ? new Date(release.addDate).toISOString().split('T')[0]
          : new Date().toISOString().split('T')[0];
      const killDate =
        release.killDate && release.killDate !== 0 ? new Date(release.killDate).toISOString().split('T')[0] : null;

      await db
        .insert(rotation)
        .values({
          legacy_rotation_id: release.id,
          legacy_library_release_id: rawLibraryId || null,
          album_id: albumId,
          rotation_bin: rotationType,
          add_date: addDate,
          kill_date: killDate,
          artist_name: albumId ? null : truncate(release.artistName, 128),
          album_title: albumId ? null : truncate(release.albumTitle, 128),
          record_label: albumId ? null : truncate(release.labelName, 128),
        })
        .onConflictDoUpdate({
          target: rotation.legacy_rotation_id,
          set: {
            album_id: sql`excluded.album_id`,
            legacy_library_release_id: sql`excluded.legacy_library_release_id`,
            rotation_bin: sql`excluded.rotation_bin`,
            kill_date: sql`excluded.kill_date`,
            artist_name: sql`excluded.artist_name`,
            album_title: sql`excluded.album_title`,
            record_label: sql`excluded.record_label`,
          },
        });
    }

    serverEventsMgr.broadcast(Topics.liveFs, {
      type: FsEvents.refetch,
      payload: { source: 'rotation-webhook' },
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('[webhook] Rotation webhook error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---- Streaming Status Webhook ----

/**
 * Authenticate via Authorization: Bearer token (used by LML streaming webhook).
 * Separate from authenticateInternal which uses X-Internal-Key.
 */
function authenticateBearer(authHeader: string | undefined): boolean {
  if (!ETL_NOTIFY_KEY || !authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return !!match && match[1] === ETL_NOTIFY_KEY;
}

interface StreamingChange {
  library_release_id: number;
  on_streaming: boolean | null;
}

/**
 * POST /internal/streaming-status-webhook
 *
 * Receives bulk ON_STREAMING updates from LML after each library.db upload.
 * Updates the `on_streaming` column in the `library` table for each change.
 *
 * Auth: Authorization: Bearer <ETL_NOTIFY_KEY>
 *
 * Payload:
 *   { changes: [{ library_release_id: number, on_streaming: boolean | null }], timestamp: string }
 */
internal_route.post('/streaming-status-webhook', async (req, res) => {
  if (!authenticateBearer(req.get('Authorization'))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { changes } = req.body ?? {};

  if (!Array.isArray(changes)) {
    res.status(400).json({ error: 'Missing or invalid field: changes (expected array)' });
    return;
  }

  let processed = 0;
  let errors = 0;

  for (const change of changes as StreamingChange[]) {
    try {
      const legacyId = change.library_release_id;
      const onStreaming = change.on_streaming ?? null;

      await db
        .update(library)
        .set({ on_streaming: onStreaming })
        .where(eq(library.legacy_release_id, legacyId));

      processed++;
    } catch (e) {
      console.error('[webhook] Streaming status update error:', e);
      errors++;
    }
  }

  res.json({ processed, errors });
});
