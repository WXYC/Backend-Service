import type { QueryParams } from '../../controllers/flowsheet.controller';
import { db } from '@wxyc/database';
import { user, flowsheet, shows, FSEntry, Show } from '@wxyc/database';
import { and, eq, isNull } from 'drizzle-orm';
import * as Sentry from '@sentry/node';
import { Request, Response } from 'express';
import {
  createBackendMirrorMiddleware,
  createHttpMirrorMiddleware,
  isMirrorEnabled,
  type MirrorFlagRequest,
} from './mirror.middleware.js';
import { safeSql, safeSqlNum, toMs } from './utilities.mirror.js';
import {
  mirrorCreateEntry,
  mirrorCreateShow,
  mirrorSignoffShow,
  mirrorUpdateEntry,
  cacheEntryId,
  cacheShowId,
  getCachedEntryId,
  getCachedShowId,
  mapEntryToTubafrenzy,
  mapShowToTubafrenzy,
  mapUpdateToTubafrenzy,
} from './http.mirror.js';
import { isActiveRotationMatch } from './rotation-match.mirror.js';

const FLOWSHEET_ENTRY_TABLE = 'FLOWSHEET_ENTRY_PROD';
const RADIO_SHOW_TABLE = 'FLOWSHEET_RADIO_SHOW_PROD';

const getEntries = createBackendMirrorMiddleware<any>(async (req, data) => {
  const query = req.query as QueryParams;

  const page = parseInt(query.page ?? '0');
  const limit = parseInt(query.limit ?? '30');
  const offset = page * limit;

  return [`SELECT * FROM ${FLOWSHEET_ENTRY_TABLE} LIMIT ${limit} OFFSET ${offset};`];
});

/**
 * Positive Show discriminant for the /flowsheet/join and /flowsheet/end
 * responses, which serve join/leave semantics through the same registration:
 * a co-host join or a guest-DJ leave (or the Auto-DJ orchestrator's restart
 * recovery) answers with a ShowDJ instead of a Show (BS#1119). Discriminate
 * on Show's OWN keys — `primary_dj_id` is present on every Show payload even
 * when its value is null, because the response is a JSON round-trip of the
 * full row — rather than duck-typing on fields the OTHER shape happens to
 * lack (the old `show.id == null` form would silently re-open BS#1119 the day
 * show_djs gains a serial id, exactly the trap the issue body named). An
 * unrecognized shape (neither Show keys nor the ShowDJ `dj_id`) is skipped
 * LOUDLY — console.warn AND Sentry: if a future projection change strips
 * Show's keys from the response, the mirror must not go quiet without a trace
 * (BS#1119 follow-up review).
 */
const isShowPayload = (data: unknown): data is Show => {
  if (typeof data !== 'object' || data == null) return false;
  // `id` is tested by VALUE, not just presence: every downstream read keys on
  // it (getCachedShowId(show.id), eq(flowsheet.show_id, show.id)), and a null
  // id binds NULL into the announcement re-query — matching nothing, dropping
  // the marker silently. That is the BS#1119 failure mode itself, so a
  // Show-shaped payload with a null id belongs in the loud lane below, not
  // past the gate. `primary_dj_id` stays a PRESENCE test: null is a legitimate
  // value for it (onDelete 'set null') and its key is what identifies the shape.
  if ('primary_dj_id' in data && (data as { id?: unknown }).id != null) return true;
  if (!('dj_id' in data)) {
    const keys = Object.keys(data);
    console.warn('[mirror] Unrecognized show-route payload shape; skipping mirror. keys=', keys);
    // console.warn alone is invisible in prod — nothing alerts on the EC2
    // container's stdout. This is the silent-stop lane (a projection change
    // that strips Show's keys stops every sign-off mirroring), so it has to
    // reach the channel the team actually watches.
    Sentry.captureMessage('[mirror] Unrecognized show-route payload shape; skipping mirror', {
      level: 'warning',
      tags: { subsystem: 'legacy-mirror', variant: 'http' },
      extra: { keys },
    });
  }
  return false;
};

/**
 * PostHog `backend-mirror` identity for a show-lifecycle payload: the show's
 * own primary DJ. See `MirrorOptions.resolveFlagIdentity` (mirror.middleware.ts)
 * for why the decision must be per-show rather than per-caller.
 */
const showFlagIdentity = (show: Show): string | null => show.primary_dj_id ?? null;

/**
 * The same identity for an entry payload, which names its show by id rather
 * than carrying the primary DJ. One PK lookup, paid only when PostHog is
 * configured (`isMirrorEnabled` resolves this lazily) and only on mutations
 * that already POST to tubafrenzy.
 */
const entryFlagIdentity = async (entry: FSEntry): Promise<string | null> => {
  if (entry.show_id == null) return null;
  const showRow = await db
    .select({ primary_dj_id: shows.primary_dj_id })
    .from(shows)
    .where(eq(shows.id, entry.show_id))
    .limit(1);
  return showRow?.[0]?.primary_dj_id ?? null;
};

/**
 * Mirror a show-lifecycle announcement marker (`show_start` / `show_end`) to
 * tubafrenzy, then persist its surrogate key.
 *
 * BS#1705: target the marker by `entry_type` rather than the newest row by
 * play_order. In normal operation the marker is the only (and newest) entry
 * when this fires, so the old `ORDER BY play_order DESC LIMIT 1` happened to
 * return it — but when a track already exists for the show, the DESC query
 * returns the TRACK: the marker is never mirrored (prod: BS shows.id 1949437 /
 * tubafrenzy 172277 has no START_OF_SHOW), and on the endShow side the
 * already-mirrored track was re-POSTed as a duplicate with two racing
 * legacy_entry_id persists. `isNull(legacy_entry_id)` keeps a re-fire
 * idempotent (mirrors addEntry's BS#908 loop guard).
 *
 * Both call sites had drifted apart as near-identical copies — endShow kept the
 * bare DESC query for months after startShow was hardened, which is what the
 * BS#1119 follow-up review had to fix. One function, one query, no drift.
 *
 * `tubafrenzyShowId` is non-nullable BY TYPE: mapEntryToTubafrenzy accepts a
 * null radio-show id, so a caller that skipped its show-create failure check
 * would POST an orphan entry with no parent show AND stamp legacy_entry_id on
 * the marker, poisoning it against legacy-mirror-reconcile's
 * `legacy_entry_id IS NULL` sweep — permanently unrecoverable. Callers guard.
 */
const mirrorAnnouncementEntry = async (
  showId: number,
  entryType: 'show_start' | 'show_end',
  tubafrenzyShowId: number
): Promise<void> => {
  const announcementEntry = await db
    .select()
    .from(flowsheet)
    .where(and(eq(flowsheet.show_id, showId), eq(flowsheet.entry_type, entryType), isNull(flowsheet.legacy_entry_id)))
    .limit(1);

  const marker = announcementEntry?.[0];
  if (!marker) return;

  const entryBody = mapEntryToTubafrenzy(marker, tubafrenzyShowId);
  const entryId = await mirrorCreateEntry(entryBody);
  if (entryId == null) return;

  // BS#1103: key by the flowsheet row id, not play_order (only unique per-show).
  cacheEntryId(marker.id, entryId);
  try {
    await db.update(flowsheet).set({ legacy_entry_id: entryId }).where(eq(flowsheet.id, marker.id));
  } catch (e) {
    console.error('[mirror] Failed to persist legacy_entry_id for announcement:', e);
  }
};

const startShow = createHttpMirrorMiddleware<Show>(
  async (_req, show) => {
    // Mirroring a show creation needs a resolvable primary DJ; a Show with a
    // NULL primary_dj_id (legacy/shadow shows, onDelete 'set null') stays
    // unmirrored here — the reconcile cron's sweep 1 applies the same
    // primary_dj_id IS NOT NULL predicate. ShowDJ co-host joins never reach
    // this handler (isShowPayload below); whether their dj_join markers should
    // mirror at all is BS#2094.
    const djId = show.primary_dj_id;
    if (!djId) return;

    const dj = (await db.select().from(user).where(eq(user.id, djId)).limit(1))?.[0];

    if (!dj) return;

    // 1. Create show in tubafrenzy via REST API
    const body = mapShowToTubafrenzy(show, dj);
    const tubafrenzyShowId = await mirrorCreateShow(body);

    // A failed show-create leaves nothing to hang entries off. Skip the whole
    // tail rather than POST an orphan announcement — legacy-mirror-reconcile's
    // sweep 1 recreates the show and drives its entries from the durable
    // `legacy_show_id IS NULL` signal, but only if this run stamped nothing.
    if (tubafrenzyShowId == null) return;

    // Cache for subsequent addEntry calls in this process lifetime
    cacheShowId(show.id, tubafrenzyShowId);
    // Persist for ETL dedup and restart resilience
    try {
      await db.update(shows).set({ legacy_show_id: tubafrenzyShowId }).where(eq(shows.id, show.id));
    } catch (e) {
      console.error('[mirror] Failed to persist legacy_show_id:', e);
    }

    // 2. Mirror the show_start announcement entry.
    await mirrorAnnouncementEntry(show.id, 'show_start', tubafrenzyShowId);
  },
  { shouldMirror: isShowPayload, resolveFlagIdentity: showFlagIdentity }
);

/**
 * Sign one closed show off in tubafrenzy and mirror its `show_end` marker.
 *
 * Extracted from the `endShow` response tap so `POST /flowsheet/join`'s
 * takeover branch can close a show through the identical sequence. Chaining
 * `flowsheetMirror.endShow` onto `/join` instead is the trap: both taps read
 * the SAME `res.locals.mirrorData` key under the same `isShowPayload` gate, so
 * on a takeover both would receive the payload of the show that just STARTED
 * and the end-tap would sign off the live broadcast.
 *
 * Takes the closed `Show` and resolves the tubafrenzy id itself rather than
 * accepting one. `getCachedShowId` is module-private and is the *primary*
 * source whenever `startShow`'s `legacy_show_id` persist failed, so a caller
 * passing a pre-resolved id would silently drop the cache lookup and
 * mis-target the sign-off.
 */
const mirrorShowSignoff = async (show: Show): Promise<void> => {
  const endMs = toMs(show.end_time ?? Date.now());

  // Resolve tubafrenzy show ID: in-memory cache → persisted legacy_show_id
  const tubafrenzyShowId = getCachedShowId(show.id) ?? show.legacy_show_id;

  // No tubafrenzy show to sign off or hang the END_OF_SHOW entry off (the
  // startShow mirror failed, or this process never saw it and the persist
  // failed too). Both arms skip together; legacy-mirror-reconcile heals it.
  if (tubafrenzyShowId == null) return;

  await mirrorSignoffShow(tubafrenzyShowId, endMs);
  await mirrorAnnouncementEntry(show.id, 'show_end', tubafrenzyShowId);
};

export const endShow = createHttpMirrorMiddleware<Show>(
  // BS#1119's ShowDJ-vs-Show discrimination lives in `isShowPayload`, passed
  // as this registration's shouldMirror gate — a guest leave never reaches
  // this handler (and never pays the PostHog flag round-trip).
  (_req, show) => mirrorShowSignoff(show),
  { shouldMirror: isShowPayload, resolveFlagIdentity: showFlagIdentity }
);

/**
 * Queue the tubafrenzy sign-off for a show `POST /flowsheet/join` closed as
 * part of a takeover (BS#2233).
 *
 * The takeover ends one show and starts another in a single request, but the
 * route can only carry ONE response-tap payload — the new show, which
 * `flowsheetMirror.startShow` needs. The close therefore mirrors from here,
 * with the closed `Show` passed explicitly.
 *
 * Deferred to `res.once('finish')` rather than awaited inline, matching both
 * mirror factories. Awaiting would put tubafrenzy's HTTP latency on the
 * go-live path, and a tubafrenzy outage would 500 the takeover *after*
 * `endShow` already committed `end_time` — stranding the DJ off air with no
 * show, a worse version of the bug being fixed.
 *
 * Deliberately NOT gated on `res.statusCode`, which is where this departs from
 * the taps. A tap decides whether a mutation happened by reading the status
 * code; here the close has ALREADY COMMITTED before this is called, so a later
 * failure in the same request (`startShow` throwing, say) changes nothing
 * about whether tubafrenzy needs to hear about it. Skipping the sign-off on a
 * non-2xx would leave exactly the BS-closed/tubafrenzy-open split brain that
 * produced this incident's ambiguity.
 */
export const scheduleTakeoverSignoff = (req: MirrorFlagRequest, res: Response, closedShow: Show): void => {
  res.once('finish', () => {
    void (async () => {
      try {
        if (!(await isMirrorEnabled(req, () => Promise.resolve(showFlagIdentity(closedShow))))) return;
        await mirrorShowSignoff(closedShow);
      } catch (e) {
        console.error('Error in takeover sign-off mirror:', e);
        Sentry.captureException(e, { tags: { subsystem: 'legacy-mirror', variant: 'http' } });
      }
    })();
  });
};

const getAddEntrySQL = async (req: Request, entry: FSEntry) => {
  const startMs = entry?.add_time ? new Date(entry.add_time).getTime() : Date.now();
  const radioHour = Math.floor(startMs / 3_600_000) * 3_600_000;

  const statements: string[] = [];

  // 1) Resolve legacy RADIO_SHOW_ID for the active modern show
  statements.push(
    `SET @RS_ID := (SELECT IFNULL(MAX(ID), 0) FROM ${RADIO_SHOW_TABLE});`,

    // 2) Get next sequence number within the show
    `SET @SEQ_NUM := (SELECT IFNULL(MAX(SEQUENCE_WITHIN_SHOW), 0) + 1 FROM ${FLOWSHEET_ENTRY_TABLE} WHERE RADIO_SHOW_ID = @RS_ID);`,

    // 3) Allocate new legacy entry ID
    `SET @NEW_FE_ID := (SELECT IFNULL(MAX(ID), 0) + 1 FROM ${FLOWSHEET_ENTRY_TABLE});`,

    // 4) Update WORKING_HOUR in radio show if we're in a new hour bucket
    `UPDATE ${RADIO_SHOW_TABLE}
        SET WORKING_HOUR = ${safeSqlNum(radioHour)},
            TIME_LAST_MODIFIED = ${safeSqlNum(startMs)}
      WHERE ID = @RS_ID
        AND WORKING_HOUR < ${safeSqlNum(radioHour)};`,

    // 5) Close prior "now playing" (if any) for this show
    `UPDATE ${FLOWSHEET_ENTRY_TABLE}
        SET NOW_PLAYING_FLAG = 0,
            STOP_TIME = ${safeSqlNum(startMs)},
            TIME_LAST_MODIFIED = ${safeSqlNum(startMs)}
      WHERE RADIO_SHOW_ID = @RS_ID
        AND NOW_PLAYING_FLAG = 1
        AND STOP_TIME = 0;`
  );

  // Determine legacy entry type code based on entry_type field (if available) or message patterns
  // Legacy type codes: 0-4=rotation tracks, 6=library, 7=talkset, 8=breakpoint, 9=start, 10=end
  const entryType = entry.entry_type;

  // Non-track entries (messages, events, etc.)
  if (
    entryType === 'show_start' ||
    entryType === 'show_end' ||
    entryType === 'dj_join' ||
    entryType === 'dj_leave' ||
    entryType === 'talkset' ||
    entryType === 'breakpoint' ||
    entryType === 'message' ||
    (entry?.message && entry.message.trim() !== '' && entryType !== 'track')
  ) {
    let message = entry.message?.trim() ?? '';
    let entryTypeCode = 7; // Default to talkset
    const nowPlayingFlag = 0;
    let startTime = 0;

    // Map entry_type to legacy type codes
    if (entryType === 'show_start') {
      entryTypeCode = 9;
      startTime = startMs;
    } else if (entryType === 'show_end') {
      entryTypeCode = 10;
      startTime = startMs;
    } else if (entryType === 'dj_join' || entryType === 'dj_leave') {
      entryTypeCode = 7; // Map to talkset in legacy
    } else if (entryType === 'talkset' || entryType === 'message') {
      entryTypeCode = 7;
      message = '------ talkset -------';
    } else if (entryType === 'breakpoint') {
      entryTypeCode = 8;
      message = message.toUpperCase() || 'BREAKPOINT';
    } else {
      // Fallback to pattern matching for backwards compatibility
      if (message.toLowerCase().includes('breakpoint')) {
        entryTypeCode = 8;
        message = message.toUpperCase();
      } else if (message.toLowerCase().includes('start of show') || message.toLowerCase().includes('signed on')) {
        entryTypeCode = 9;
        startTime = startMs;
      } else if (message.toLowerCase().includes('end of show') || message.toLowerCase().includes('signed off')) {
        entryTypeCode = 10;
        startTime = startMs;
      } else {
        message = '------ talkset -------';
      }
    }

    statements.push(
      `INSERT INTO ${FLOWSHEET_ENTRY_TABLE}
      (ID, ARTIST_NAME, ARTIST_ID, SONG_TITLE, RELEASE_TITLE, RELEASE_FORMAT_ID,
       LIBRARY_RELEASE_ID, ROTATION_RELEASE_ID, LABEL_NAME, RADIO_HOUR, START_TIME, STOP_TIME,
       RADIO_SHOW_ID, SEQUENCE_WITHIN_SHOW, NOW_PLAYING_FLAG, FLOWSHEET_ENTRY_TYPE_CODE_ID,
       TIME_LAST_MODIFIED, TIME_CREATED, REQUEST_FLAG, SEGUE_FLAG, GLOBAL_ORDER_ID, BMI_COMPOSER)
     VALUES
      (@NEW_FE_ID,
       ${safeSql(message)},                   -- ARTIST_NAME
       0,                                     -- ARTIST_ID
       '',                                    -- SONG_TITLE
       '',                                    -- RELEASE_TITLE
       0,                                     -- RELEASE_FORMAT_ID
       0,                                     -- LIBRARY_RELEASE_ID
       0,                                     -- ROTATION_RELEASE_ID
       '',                                    -- LABEL_NAME
       ${safeSqlNum(radioHour)},              -- RADIO_HOUR (hour bucket)
       ${safeSqlNum(startTime)},              -- START_TIME (0 for talksets/breakpoints, actual time for start/end)
       0,                                     -- STOP_TIME
       @RS_ID,                                -- RADIO_SHOW_ID (legacy)
       @SEQ_NUM,                              -- SEQUENCE_WITHIN_SHOW
       ${nowPlayingFlag},                     -- NOW_PLAYING_FLAG (0 for announcements)
       ${entryTypeCode},                      -- FLOWSHEET_ENTRY_TYPE_CODE_ID (7=talkset, 8=breakpoint, 9=start, 10=end)
       ${safeSqlNum(startMs)},                -- TIME_LAST_MODIFIED
       ${safeSqlNum(startMs)},                -- TIME_CREATED
       0,                                     -- REQUEST_FLAG
       0,                                     -- SEGUE_FLAG
       (@RS_ID * 1000 + @SEQ_NUM),            -- GLOBAL_ORDER_ID (RADIO_SHOW_ID * 1000 + SEQUENCE)
       '');` // BMI_COMPOSER
    );
  } else {
    // Track entries
    // Determine entry type code based on rotation and library IDs
    // Type codes: 1-4 for different rotation types, 6 for library, 0 for manual/unknown
    let entryTypeCode = 0;
    if (entry.rotation_id && entry.rotation_id > 0) {
      // Rotation entries - default to type 2 (general rotation)
      // Would need rotation type lookup for accurate 1-4 classification
      entryTypeCode = 2;
    } else if (entry.album_id && entry.album_id > 0) {
      entryTypeCode = 6; // Library entry
    }

    statements.push(
      `INSERT INTO ${FLOWSHEET_ENTRY_TABLE}
      (ID, ARTIST_NAME, ARTIST_ID, SONG_TITLE, RELEASE_TITLE, RELEASE_FORMAT_ID,
       LIBRARY_RELEASE_ID, ROTATION_RELEASE_ID, LABEL_NAME, RADIO_HOUR, START_TIME, STOP_TIME,
       RADIO_SHOW_ID, SEQUENCE_WITHIN_SHOW, NOW_PLAYING_FLAG, FLOWSHEET_ENTRY_TYPE_CODE_ID,
       TIME_LAST_MODIFIED, TIME_CREATED, REQUEST_FLAG, SEGUE_FLAG, GLOBAL_ORDER_ID, BMI_COMPOSER)
     VALUES
      (@NEW_FE_ID,
       ${safeSql(entry.artist_name)},             -- ARTIST_NAME
       0,                                         -- ARTIST_ID
       ${safeSql(entry.track_title)},             -- SONG_TITLE
       ${safeSql(entry.album_title)},             -- RELEASE_TITLE
       0,                                         -- RELEASE_FORMAT_ID
       ${safeSqlNum(entry.album_id)},             -- LIBRARY_RELEASE_ID
       ${safeSqlNum(entry.rotation_id)},          -- ROTATION_RELEASE_ID
       ${safeSql(entry.record_label)},            -- LABEL_NAME
       ${safeSqlNum(radioHour)},                  -- RADIO_HOUR (hour bucket)
       0,                                         -- START_TIME (0 for regular songs)
       0,                                         -- STOP_TIME
       @RS_ID,                                    -- RADIO_SHOW_ID (legacy)
       @SEQ_NUM,                                  -- SEQUENCE_WITHIN_SHOW
       1,                                         -- NOW_PLAYING_FLAG (set to 1 for new entries)
       ${entryTypeCode},                          -- FLOWSHEET_ENTRY_TYPE_CODE_ID
       ${safeSqlNum(startMs)},                    -- TIME_LAST_MODIFIED
       ${safeSqlNum(startMs)},                    -- TIME_CREATED
       ${safeSqlNum(entry.request_flag ? 1 : 0)}, -- REQUEST_FLAG (bool --> int)
       ${safeSqlNum(entry.segue ? 1 : 0)},        -- SEGUE_FLAG (bool --> int)
       (@RS_ID * 1000 + @SEQ_NUM),                -- GLOBAL_ORDER_ID (RADIO_SHOW_ID * 1000 + SEQUENCE)
       '');` // BMI_COMPOSER
    );
  }

  return statements;
};

export const addEntry = createHttpMirrorMiddleware<FSEntry>(
  async (_req, entry) => {
    // Loop guard (use #2 of the legacy_entry_id four-use invariant, BS#908;
    // use #4 added by BS#2119): `legacy_entry_id != null` is read as a
    // boolean meaning "this row came from tubafrenzy via ETL or webhook, do
    // not mirror back." Together with the matching guard in updateEntry
    // below (line ~317) this prevents an infinite ETL → mirror → webhook →
    // ETL cycle. The four orthogonal uses and their constraints are
    // documented at `shared/database/src/schema.ts` on the column
    // declaration; CI enforces no new write site appears without
    // registering at `scripts/check-legacy-entry-id-writes.mjs`.
    if (entry.legacy_entry_id != null) return;

    // Resolve tubafrenzy show ID: (1) in-memory cache, (2) DB, (3) null (auto-resolve)
    let radioShowID: number | null | undefined = entry.show_id != null ? getCachedShowId(entry.show_id) : undefined;
    if (radioShowID == null && entry.show_id != null) {
      try {
        const showRow = await db
          .select({ legacy_show_id: shows.legacy_show_id })
          .from(shows)
          .where(eq(shows.id, entry.show_id))
          .limit(1);
        radioShowID = showRow?.[0]?.legacy_show_id ?? null;
        if (radioShowID != null) {
          cacheShowId(entry.show_id, radioShowID);
        }
      } catch {
        // DB lookup failed; fall back to tubafrenzy auto-resolution
      }
    }

    const isRotationMatch = await isActiveRotationMatch(entry);
    const body = mapEntryToTubafrenzy(entry, radioShowID, isRotationMatch);
    const tubafrenzyId = await mirrorCreateEntry(body);
    if (tubafrenzyId != null) {
      // BS#1103: key by the flowsheet row id, not play_order — play_order
      // resets per show, so two shows in the same process lifetime can
      // collide on the same slot and evict each other's cached entry.
      cacheEntryId(entry.id, tubafrenzyId);
      // Persist the mapping so the ETL can deduplicate
      try {
        await db.update(flowsheet).set({ legacy_entry_id: tubafrenzyId }).where(eq(flowsheet.id, entry.id));
      } catch (e) {
        console.error('[mirror] Failed to persist legacy_entry_id:', e);
      }
    }
  },
  { resolveFlagIdentity: entryFlagIdentity }
);

export const updateEntry = createHttpMirrorMiddleware<FSEntry>(
  async (_req, entry) => {
    // Message-only rows aren't updateable
    if (entry?.message && entry.message.trim() !== '') return;

    // BS#1103: key by the flowsheet row id, not play_order — see cacheEntryId call in addEntry above.
    const cachedId = getCachedEntryId(entry.id);

    // Loop guard: entry has a legacy ID but we didn't cache it this lifecycle —
    // it was imported by the ETL, not created by our mirror. Don't mirror back.
    if (cachedId == null && entry.legacy_entry_id != null) return;

    // Use cache (fast path) or fall back to persisted legacy_entry_id (after restart)
    const tubafrenzyId = cachedId ?? entry.legacy_entry_id;
    if (tubafrenzyId == null) {
      console.warn('[mirror] No tubafrenzy ID for flowsheet row', entry.id);
      return;
    }

    const isRotationMatch = await isActiveRotationMatch(entry);
    const body = mapUpdateToTubafrenzy(entry, isRotationMatch);
    await mirrorUpdateEntry(tubafrenzyId, body);
  },
  { resolveFlagIdentity: entryFlagIdentity }
);

export const deleteEntry = createBackendMirrorMiddleware<FSEntry>(
  async (_req, removed) => {
    // Delete by the tubafrenzy surrogate key persisted on the row at insert
    // (`legacy_entry_id` — the same identity uses #1/#3 key their `ON CONFLICT`
    // on; see addEntry's persist above and `shared/database/src/schema.ts`).
    // BS#1101.
    //
    // The prior implementation resolved the show via `MAX(ID)` and matched the
    // row positionally by `SEQUENCE_WITHIN_SHOW = play_order`. Both predicates
    // are wrong:
    //   - `MAX(ID)` is the newest tubafrenzy show, not the deleted entry's, so
    //     correcting an older show deletes from the wrong show.
    //   - Even for the right show, tubafrenzy's `SEQUENCE_WITHIN_SHOW` (assigned
    //     at insert as `MAX(SEQUENCE_WITHIN_SHOW)+1` into `@SEQ_NUM`; see addEntry
    //     above) and BS `play_order` are assigned independently and diverge — BS
    //     `play_order` counts lifecycle markers tubafrenzy never materializes as
    //     entry rows — so the positional predicate misses even in the happy path.
    //
    // When `legacy_entry_id` is null — a residual pre-mirror row, or a row whose
    // mirror POST failed — there is no safe target, so no-op (return no
    // statements) rather than guess. The middleware skips the enqueue on empty.
    // Log the skip: a failed insert-mirror leaves a tubafrenzy row this delete
    // can never reach, so the residual is at least countable in the logs.
    if (removed.legacy_entry_id == null) {
      console.warn('[mirror] Skipping tubafrenzy delete: no legacy_entry_id on removed row', removed.id);
      return [];
    }

    return [`DELETE FROM ${FLOWSHEET_ENTRY_TABLE} WHERE ID = ${safeSqlNum(removed.legacy_entry_id)} LIMIT 1;`];
  },
  { resolveFlagIdentity: entryFlagIdentity }
);

/*
export const changeOrder = createBackendMirrorMiddleware<FSEntry>(
  async (req, moved) => {
    const entryId = Number((req.body ?? {}).entry_id);
    const newPos = Number((req.body ?? {}).new_position);

    if (!entryId || !newPos) return []; // hard guard; controller already validated

    const statements: string[] = [];

    // 1) Resolve this legacy show row
    statements.push(
      `SET @RS_ID := (SELECT ID FROM ${RADIO_SHOW_TABLE}
                     WHERE SHOW_ID = ${safeSqlNum(moved.show_id)}
                     ORDER BY TIME_CREATED DESC LIMIT 1);`
    );

    // 2) Locate the legacy entry for the moved row via GLOBAL_ORDER_ID
    statements.push(
      `SET @E_ID := (SELECT ID FROM ${FLOWSHEET_ENTRY_TABLE}
                    WHERE GLOBAL_ORDER_ID = ${safeSqlNum(entryId)}
                      AND RADIO_SHOW_ID = @RS_ID
                    LIMIT 1);`
    );

    // Optional: fallback if GLOBAL_ORDER_ID wasn’t set (rare once add-entry is updated)
    statements.push(
      `SET @E_ID := IFNULL(@E_ID, (SELECT ID FROM ${FLOWSHEET_ENTRY_TABLE}
                                  WHERE RADIO_SHOW_ID = @RS_ID
                                  ORDER BY SEQUENCE_WITHIN_SHOW DESC LIMIT 1));`
    );

    // 3) Read old position
    statements.push(
      `SET @OLD_POS := (SELECT SEQUENCE_WITHIN_SHOW FROM ${FLOWSHEET_ENTRY_TABLE}
                       WHERE ID = @E_ID LIMIT 1);`,
      `SET @NEW_POS := ${safeSqlNum(newPos)};`
    );

    // 4) Shift neighbors, then place the moved entry
    // Move upward: new position is smaller number
    statements.push(
      `UPDATE ${FLOWSHEET_ENTRY_TABLE}
        SET SEQUENCE_WITHIN_SHOW = SEQUENCE_WITHIN_SHOW + 1
      WHERE RADIO_SHOW_ID = @RS_ID
        AND @NEW_POS < @OLD_POS
        AND SEQUENCE_WITHIN_SHOW >= @NEW_POS
        AND SEQUENCE_WITHIN_SHOW <  @OLD_POS;`
    );
    // Move downward: new position is larger number
    statements.push(
      `UPDATE ${FLOWSHEET_ENTRY_TABLE}
        SET SEQUENCE_WITHIN_SHOW = SEQUENCE_WITHIN_SHOW - 1
      WHERE RADIO_SHOW_ID = @RS_ID
        AND @NEW_POS > @OLD_POS
        AND SEQUENCE_WITHIN_SHOW >  @OLD_POS
        AND SEQUENCE_WITHIN_SHOW <= @NEW_POS;`
    );
    // Place moved entry
    statements.push(
      `UPDATE ${FLOWSHEET_ENTRY_TABLE}
        SET SEQUENCE_WITHIN_SHOW = @NEW_POS,
            TIME_LAST_MODIFIED = ${safeSqlNum(Date.now())}
      WHERE ID = @E_ID
      LIMIT 1;`
    );

    return statements;
  }
);
*/

export const flowsheetMirror = {
  getEntries,
  startShow,
  endShow,
  addEntry,
  updateEntry,
  deleteEntry,
  // Not a middleware: the takeover branch calls this directly. See its
  // docstring for why the sign-off cannot ride a second response tap.
  scheduleTakeoverSignoff,
  /*changeOrder,*/
};
