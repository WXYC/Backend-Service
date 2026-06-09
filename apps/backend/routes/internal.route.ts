import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db, flowsheet, shows, rotation, library, truncate, user } from '@wxyc/database';
import { serverEventsMgr, Topics, FsEvents } from '../utils/serverEvents.js';
import { mapProdEntryType, isMessageEntryType } from '../utils/flowsheet-transform.js';

const ETL_NOTIFY_KEY = process.env.ETL_NOTIFY_KEY ?? '';

// Marker entry types that surface `dj_name` on the v2 wire (and so must be
// resolved on the webhook insert path — BS#1371). Track + message-typed rows
// follow other rules and are intentionally excluded.
const MARKER_ENTRY_TYPES = new Set(['show_start', 'show_end', 'dj_join', 'dj_leave']);

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

interface ResolvedShow {
  id: number;
  /**
   * COALESCE(auth_user.dj_name, shows.legacy_dj_name, auth_user.name) —
   * matches the ETL / dj-name-backfill convention. Raw COALESCE (not the
   * `resolveDjDisplayName` helper) on purpose: the live `startShow` /
   * `endShow` path filters the literal 'Anonymous'; the ETL + backfill
   * jobs do not. If the webhook used the helper and the same row were
   * later re-resolved by the ETL or backfill, the two writers would
   * disagree — drift instead of fix. See jobs/flowsheet-etl/job.ts:84-86
   * and jobs/flowsheet-dj-name-backfill/job.ts for the convention.
   *
   * Null when the show has no resolvable name from any of the three
   * sources (stub shows pre-ETL-fill; legacy rows with no primary_dj_id
   * and no legacy_dj_name).
   */
  dj_name: string | null;
}

/**
 * Look up a show by legacy_show_id, creating a stub if it doesn't exist.
 * Uses onConflictDoNothing + re-select for concurrent-insert safety.
 *
 * Also resolves the show's display dj_name via a LEFT JOIN to auth_user on
 * `shows.primary_dj_id` — same query path, no extra round-trip. The webhook
 * INSERT writes this onto marker rows so the v2 wire honours the
 * FLOWSHEET_DJ_NAME_NON_NULL contract (BS#1371).
 */
async function resolveShow(legacyShowId: number): Promise<ResolvedShow | null> {
  if (!legacyShowId) return null;

  const selectShow = () =>
    db
      .select({
        id: shows.id,
        dj_name: sql<string | null>`COALESCE(${user.djName}, ${shows.legacy_dj_name}, ${user.name})`,
      })
      .from(shows)
      .leftJoin(user, eq(user.id, shows.primary_dj_id))
      .where(eq(shows.legacy_show_id, legacyShowId))
      .limit(1);

  const existing = await selectShow();
  if (existing.length > 0) return { id: existing[0].id, dj_name: existing[0].dj_name };

  // Create a stub show — the ETL will fill in details (end_time, show_name) later.
  await db.insert(shows).values({ legacy_show_id: legacyShowId, start_time: new Date() }).onConflictDoNothing();

  const [row] = await selectShow();
  return row ? { id: row.id, dj_name: row.dj_name } : null;
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
      const isMsgType = isMessageEntryType(entryType);
      const artistName = isMsgType ? null : truncate(entry.artistName, 128);
      const albumTitle = truncate(entry.releaseTitle, 128);
      const trackTitle = truncate(entry.songTitle, 128);

      // Resolve linkage at INSERT so the CDC consumer worker sees
      // `album_id` already set and takes the linked enrichment branch;
      // without this, the worker takes the unlinked branch and writes
      // inline metadata that never reaches album_metadata until the next
      // flowsheet-etl cycle (#1028). Post-#894 inline enrichment no longer
      // fires from this route — CDC drives the consumer.
      const rawLibraryId = entry.libraryReleaseId ?? 0;
      const rawRotationId = entry.rotationReleaseId ?? 0;
      const [show, albumId, rotationId] = await Promise.all([
        resolveShow(entry.radioShowId),
        resolveAlbumId(rawLibraryId),
        resolveRotationId(rawRotationId),
      ]);
      const showId = show?.id ?? null;
      // For show_start / show_end / dj_join / dj_leave the v2 wire surfaces
      // dj_name (FLOWSHEET_DJ_NAME_NON_NULL contract). Other entry types
      // either denormalize dj_name differently (track) or don't surface it
      // (talkset, breakpoint, message), so we leave them null and let the
      // existing population paths handle them.
      //
      // dj_join / dj_leave caveat (BS#1371): the webhook payload has no
      // per-event DJ id, only radioShowId — so guest-join markers attribute
      // to shows.primary_dj_id, not the joining guest. Same known limitation
      // as flowsheet-dj-name-backfill (`jobs/flowsheet-dj-name-backfill/job.ts`);
      // the live createJoinNotification path is the only one that gets guest
      // attribution right.
      const markerDjName = MARKER_ENTRY_TYPES.has(entryType) ? (show?.dj_name ?? null) : null;

      // INSERT ... ON CONFLICT DO NOTHING RETURNING { id }: either we win
      // the insert and PG hands back exactly one row, or a concurrent
      // INSERT / prior webhook delivery already claimed the
      // `legacy_entry_id` and RETURNING is empty. The empty-RETURNING
      // signal replaces the previous `(xmax = 0)` system-column trick
      // (BS#909): same correctness, no MVCC-internal dependency, race-
      // safe under concurrent webhook delivery (acceptance criterion (c)
      // — exactly one fresh-INSERT row per legacy_entry_id, so the CDC
      // consumer worker sees exactly one INSERT event per logical row).
      //
      // `rotation_id` (BS#1268) is set on INSERT only — like `album_id`,
      // linkage is anchored to the first delivery and not refreshed on
      // ON CONFLICT updates. Tubafrenzy is the source of truth for the
      // linkage; if the operator re-binds a flowsheet entry to a different
      // rotation row, that's a new legacy_entry_id, not an UPDATE.
      const inserted = await db
        .insert(flowsheet)
        .values({
          legacy_entry_id: entry.id,
          legacy_release_id: rawLibraryId || null,
          album_id: albumId,
          rotation_id: rotationId,
          show_id: showId,
          entry_type: entryType,
          artist_name: artistName,
          album_title: albumTitle,
          track_title: trackTitle,
          record_label: truncate(entry.labelName, 128),
          message: isMsgType ? truncate(entry.artistName, 250) : null,
          dj_name: markerDjName,
          request_flag: !!entry.requestFlag,
          segue: false,
          play_order: entry.sequenceWithinShow ?? 0,
          add_time: entry.startTime ? new Date(entry.startTime) : new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: flowsheet.id });

      const created = !!inserted[0];

      if (!created) {
        // Conflict path: refresh the mutable subset of fields on the row
        // tubafrenzy is updating. Matches the original ON CONFLICT DO
        // UPDATE set-list — show_id / play_order / segue / add_time stay
        // anchored to the first INSERT's values, mutable metadata-ish
        // fields move with the latest webhook payload.
        await db
          .update(flowsheet)
          .set({
            artist_name: artistName,
            album_title: albumTitle,
            track_title: trackTitle,
            record_label: truncate(entry.labelName, 128),
            message: isMsgType ? truncate(entry.artistName, 250) : null,
            request_flag: !!entry.requestFlag,
            entry_type: entryType,
          })
          .where(eq(flowsheet.legacy_entry_id, entry.id));
      }
    }

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
 * Resolve a Backend-Service rotation_id from a tubafrenzy ROTATION_RELEASE_ID
 * (the `entry.rotationReleaseId` field on the flowsheet webhook payload, set
 * by tubafrenzy's `FlowsheetEntryAddServlet.populateRotationRelease()`).
 * Returns null if the legacy id is 0 / unset or no rotation row matches.
 *
 * Single indexed SELECT via `rotation_legacy_rotation_id_idx` (unique by the
 * tubafrenzy invariant — one rotation row per legacy_rotation_id). BS#1268.
 */
async function resolveRotationId(legacyRotationId: number): Promise<number | null> {
  if (!legacyRotationId) return null;

  const [row] = await db
    .select({ id: rotation.id })
    .from(rotation)
    .where(eq(rotation.legacy_rotation_id, legacyRotationId))
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

      // BS#1082 + BS#1312: tubafrenzy's sendRotationLinked posts only {id,
      // libraryReleaseId, action: 'update'} on linkage. Including any of the
      // payload-derived denorm fields in SET unconditionally would clobber
      // the existing row's values with the JS defaults computed above for
      // missing payload fields ('N' for rotation_bin, null for kill_date,
      // null for artist_name / album_title / record_label when albumId is
      // null). Presence-gate the SET so partial updates leave them alone.
      // The INSERT path keeps the JS-default values so the create branch
      // still populates these columns on first delivery.
      const setClause: Record<string, unknown> = {
        album_id: sql`excluded.album_id`,
        legacy_library_release_id: sql`excluded.legacy_library_release_id`,
      };
      if (release.rotationType !== undefined) {
        setClause.rotation_bin = sql`excluded.rotation_bin`;
      }
      if (release.killDate !== undefined) {
        setClause.kill_date = sql`excluded.kill_date`;
      }
      if (release.artistName !== undefined) {
        setClause.artist_name = sql`excluded.artist_name`;
      }
      if (release.albumTitle !== undefined) {
        setClause.album_title = sql`excluded.album_title`;
      }
      if (release.labelName !== undefined) {
        setClause.record_label = sql`excluded.record_label`;
      }

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
          set: setClause,
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

  try {
    await db.transaction(async (tx) => {
      for (const change of changes as StreamingChange[]) {
        try {
          const legacyId = change.library_release_id;
          const onStreaming = change.on_streaming ?? null;

          await tx.update(library).set({ on_streaming: onStreaming }).where(eq(library.legacy_release_id, legacyId));

          processed++;
        } catch (e) {
          console.error('[webhook] Streaming status update error:', e);
          errors++;
        }
      }
    });
  } catch (e) {
    console.error('[webhook] Streaming status transaction error:', e);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  res.json({ processed, errors });
});
