/**
 * One-shot repair: split a show that accumulated several DJs' sets into one
 * show per DJ, promoting the `dj_join` / `dj_leave` boundary markers to
 * `show_start` / `show_end`.
 *
 * ## Why this exists
 *
 * `POST /flowsheet/join` decides start-vs-join on `current_show?.end_time !==
 * null` (`apps/backend/controllers/flowsheet.controller.ts`). When a DJ leaves
 * without signing off, the show stays open forever, and every subsequent DJ
 * who hits Go Live is silently attached to it as a guest instead of starting
 * their own show. BS#1861 closed the variant where the sign-off *did* happen
 * and only `end_time` lagged — both of its guards key on a `show_end` marker
 * existing, so neither can fire when nobody ever signed off. WXYC/dj-site#1035
 * tracks the general case.
 *
 * Production show 1951224 on 2026-08-28 is the reference incident: `dj sue`
 * signed on at 11:02 PDT and never signed off; DJ String Theory, Panzón, dj
 * eureka! and Dj xD each went live over the following ten hours and all four
 * landed in her show. The public on-air name read "dj sue" the whole time,
 * because `resolveDjNameForShow` falls through to `shows.legacy_dj_name` when
 * `primary_dj_id` is NULL, which it is for every tubafrenzy-mirrored show.
 *
 * ## What it does
 *
 * Boundary rules live in `segment.ts` and are unit-tested against that show's
 * real marker sequence. Per segment this job then:
 *
 *   - leaves the leading segment on the original `shows` row, stamping its
 *     `end_time` at the instant the next DJ went live;
 *   - inserts a new `shows` row for every later segment, owned by that DJ via
 *     `primary_dj_id` — so the on-air name resolves through `auth_user.dj_name`
 *     and can never fall back to the previous DJ's legacy handle;
 *   - re-points `flowsheet.show_id` and renumbers `play_order` from 1 within
 *     each show, so each reads like a show that started normally;
 *   - promotes the boundary `dj_join` to `show_start` and its matching
 *     `dj_leave` to `show_end`, minting a `show_end` only where the DJ never
 *     signed off and the next go-live is the sole evidence the set ended;
 *   - moves each `show_djs` membership to the show that DJ actually ran.
 *
 * New shows are written with `legacy_show_id = NULL` on purpose: it keeps them
 * outside `jobs/flowsheet-etl`'s `ON CONFLICT (legacy_show_id) DO UPDATE`, so a
 * later ETL pass cannot overwrite them from tubafrenzy.
 *
 * ## The tubafrenzy half is not optional
 *
 * The ETL's incremental upsert sets `end_time: excluded.end_time` whenever it
 * differs, and `epochMsToDate(0)` is `null` — so while tubafrenzy still holds
 * `SIGNOFF_TIME = 0` for the original show, any ETL pass reverts the repaired
 * `end_time` straight back to NULL. `flowsheet-etl` is not currently in the
 * EC2 crontab, so nothing reverts it on a schedule today, but a manual run
 * would. This job therefore also stamps `FLOWSHEET_RADIO_SHOW_PROD.SIGNOFF_TIME`
 * to the same instant, which makes the ETL upsert a no-op over the repair
 * (`setWhere`'s `IS DISTINCT FROM` stops matching) rather than a revert.
 *
 * It deliberately does NOT re-point tubafrenzy's `FLOWSHEET_ENTRY_PROD.RADIO_SHOW_ID`
 * rows. `GLOBAL_ORDER_ID = RADIO_SHOW_ID * 1000 + SEQUENCE_WITHIN_SHOW` drives
 * that side's render order, so moving entries between shows there means
 * recomputing both columns for every row and restarting Tomcat to clear
 * `FlowsheetEntryCache`. tubafrenzy's user-facing surfaces go dark 2026-09-07;
 * its copy stays one long show, and Backend-Service — which is what the iOS
 * app, dj-site and the archive read — carries the corrected shape. If the
 * final dump capture (WXYC/wiki#123) needs the split upstream too, that is a
 * separate pass.
 *
 * ## Run procedure
 *
 * Best run when nobody is on the air. Splitting a live show re-points the
 * open segment onto a new `shows` row mid-broadcast; the DJ's next write goes
 * to the right place (it resolves through `getLatestShow`, and the new row
 * holds the highest id), but the legacy mirror will be pushing entries for a
 * show whose tubafrenzy counterpart has just been signed off.
 *
 *   Manual Build & Deploy with `target=flowsheet-show-split`, then on EC2:
 *     docker run --rm --env-file .env <image> --show-id=1951224 --dry-run 2>&1 | tee log-dry
 *     docker run --rm --env-file .env <image> --show-id=1951224 2>&1 | tee log-apply
 *
 * Environment: same as the flowsheet ETL (DB_*, and REMOTE_DB_* / SSH_* or
 * LEGACY_DB_DOCKER_CONTAINER for the mirror half).
 */

import { and, asc, eq, gt, inArray, notInArray, sql } from 'drizzle-orm';
import {
  db,
  closeDatabaseConnection,
  MirrorSQL,
  flowsheet,
  show_djs,
  shows,
  user,
  resolveShowDjName,
} from '@wxyc/database';
import { showEndMessage, showStartMessage } from './markers.js';
import { parseMinSegmentSeconds, planSegments, type Segment, type SplitEntry } from './segment.js';

// ---- Options ----

const argValue = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

export const DRY_RUN = process.argv.includes('--dry-run');
export const SKIP_MIRROR = process.argv.includes('--skip-mirror');

/**
 * Joins that close faster than this are toggle noise, not sets. Default 120s.
 * The reference incident's DJ Whiskers pair is 4 seconds apart — the
 * blind-toggle retry dj-site#1035 documents. Promoting it would mint a
 * four-second show.
 *
 * Resolved inside `main` rather than at module load so a bad value surfaces
 * through the job's own `failed` log line instead of a bare module-evaluation
 * stack trace. The parse itself lives beside the comparison it guards, in
 * `segment.ts`.
 */
const minSegmentSecondsArg = (): number => parseMinSegmentSeconds(argValue('min-segment-seconds'));

const log = (event: string, detail: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), job: 'flowsheet-show-split', event, ...detail }));

// ---- Load ----

type ShowRow = typeof shows.$inferSelect;

export const loadShow = async (showId: number): Promise<ShowRow> => {
  const row = (await db.select().from(shows).where(eq(shows.id, showId)).limit(1))[0];
  if (!row) throw new Error(`No show with id ${showId}`);
  return row;
};

export const loadEntries = async (showId: number): Promise<SplitEntry[]> => {
  const rows = await db
    .select({
      id: flowsheet.id,
      play_order: flowsheet.play_order,
      add_time: flowsheet.add_time,
      entry_type: flowsheet.entry_type,
      dj_name: flowsheet.dj_name,
    })
    .from(flowsheet)
    .where(eq(flowsheet.show_id, showId))
    .orderBy(asc(flowsheet.play_order), asc(flowsheet.id));

  return rows.map((r) => ({
    id: r.id,
    play_order: r.play_order ?? 0,
    add_time: r.add_time,
    entry_type: r.entry_type,
    dj_name: r.dj_name,
  }));
};

/**
 * Map each segment to the `auth_user` row that ran it.
 *
 * Marker `dj_name` holds the resolved public handle written at insert time,
 * and `show_djs` holds the account ids that participated — so the join is
 * handle-to-handle against `auth_user.dj_name`. A segment that doesn't resolve
 * is reported and left owned by nobody rather than guessed at: writing the
 * wrong `primary_dj_id` would attribute one DJ's set to another, which is the
 * exact class of error this job exists to undo.
 */
export const resolveSegmentDjs = async (
  showId: number,
  segments: Segment[]
): Promise<Map<number, { id: string; djName: string | null }>> => {
  const members = await db
    .select({ id: user.id, djName: user.djName })
    .from(show_djs)
    .innerJoin(user, eq(user.id, show_djs.dj_id))
    .where(eq(show_djs.show_id, showId));

  // Two accounts whose handles fold to the same key make the marker's `dj_name`
  // insufficient to tell them apart, and a Map would silently keep the last one
  // — resolving the segment to a coin flip. Poison the key instead, so the
  // segment reports unresolved and lands in `warn-unresolved-djs`.
  const byHandle = new Map<string, { id: string; djName: string | null } | null>();
  for (const member of members) {
    if (!member.djName) continue;
    const handle = member.djName.trim().toLowerCase();
    byHandle.set(handle, byHandle.has(handle) ? null : member);
  }

  const resolved = new Map<number, { id: string; djName: string | null }>();
  segments.forEach((seg, i) => {
    // Segment 0 keeps the original row, whose ownership is unchanged.
    if (i === 0 || !seg.djName) return;
    const hit = byHandle.get(seg.djName.trim().toLowerCase());
    if (hit) resolved.set(i, hit);
  });
  return resolved;
};

// ---- Apply ----

export const applySplit = async (
  original: ShowRow,
  segments: Segment[],
  segmentDjs: Map<number, { id: string; djName: string | null }>
): Promise<void> => {
  await db.transaction(async (tx) => {
    const [lead] = segments;

    // 1. Close the original show at the instant the next DJ went live.
    await tx.update(shows).set({ end_time: lead.endTime }).where(eq(shows.id, original.id));
    log('lead-show-closed', { show_id: original.id, end_time: lead.endTime?.toISOString() ?? null });

    // 2. One new show per later segment.
    const newShowIds = new Map<number, number>();
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      const dj = segmentDjs.get(i);
      const inserted = await tx
        .insert(shows)
        .values({
          primary_dj_id: dj?.id ?? null,
          start_time: seg.startTime,
          end_time: seg.endTime,
          // NULL on purpose — keeps these rows out of the flowsheet ETL's
          // legacy_show_id upsert. See the module docblock.
          legacy_show_id: null,
          legacy_dj_name: dj ? null : seg.djName,
        })
        .returning({ id: shows.id });
      newShowIds.set(i, inserted[0].id);
      log('show-created', {
        show_id: inserted[0].id,
        dj_name: seg.djName,
        primary_dj_id: dj?.id ?? null,
        start_time: seg.startTime.toISOString(),
        end_time: seg.endTime?.toISOString() ?? null,
        entries: seg.entryIds.length,
      });
    }

    const showIdForSegment = (i: number): number => (i === 0 ? original.id : newShowIds.get(i)!);

    // 3. Re-point entries and renumber play_order from 1 within each show, so
    //    a split show reads like one that started normally rather than one
    //    beginning at play_order 106.
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const targetShowId = showIdForSegment(i);
      for (let n = 0; n < seg.entryIds.length; n++) {
        await tx
          .update(flowsheet)
          .set({ show_id: targetShowId, play_order: n + 1 })
          .where(eq(flowsheet.id, seg.entryIds[n]));
      }
    }

    // 3b. Re-denormalize `flowsheet.dj_name` on the moved rows.
    //
    //     `POST /flowsheet` resolves the on-air name ONCE per request and copies
    //     it onto every row it writes (`addEntry`'s `resolveDjNameForShow`), so
    //     on a hijacked show every later DJ's tracks carry the ORIGINAL DJ's
    //     handle — for 1951224 that is `dj sue` on all 143 rows, because
    //     `primary_dj_id` was NULL and the chain fell through to
    //     `shows.legacy_dj_name`. Re-pointing `show_id` does not touch it, and
    //     that column is what the v2 wire projection, `/playlists`, and the
    //     search service's `DJ_NAME_EXPR` actually read — so without this a
    //     "successful" repair still renders and searches Panzón's set as
    //     `dj sue`. `jobs/flowsheet-dj-name-backfill` cannot mop it up either:
    //     it selects `dj_name IS NULL`, and these rows are non-null and wrong.
    //
    //     `dj_join` / `dj_leave` are excluded because they name a PERSON, not a
    //     show: the co-host markers left in place by the blip rule have to keep
    //     saying "DJ Whiskers" inside eureka!'s show. The segment's own boundary
    //     markers are in that same excluded set and already carry the right
    //     name; step 4 only restates it. Segment 0 keeps the original show's
    //     ownership, so its rows were already correct.
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.entryIds.length === 0) continue;
      // What `resolveDjNameForShow` will return for the new show: the linked
      // account's handle when the segment resolved, else the `legacy_dj_name`
      // written from the marker.
      const djName = segmentDjs.get(i)?.djName ?? seg.djName;
      const updated = await tx
        .update(flowsheet)
        .set({ dj_name: djName })
        .where(
          and(
            inArray(flowsheet.id, seg.entryIds),
            notInArray(flowsheet.entry_type, ['dj_join', 'dj_leave']),
            // `IS DISTINCT FROM`, not `<>`: a row whose `dj_name` is NULL must
            // still be corrected, and `NULL <> 'Panzón'` is NULL, not true.
            sql`${flowsheet.dj_name} IS DISTINCT FROM ${djName}`
          )
        )
        .returning({ id: flowsheet.id });
      log('dj-name-redenormalized', { show_id: showIdForSegment(i), dj_name: djName, rows: updated.length });
    }

    // 4. Promote the boundary markers.
    //
    //    NOT just an `entry_type` flip: the join/leave writers put
    //    "<name> joined the set!" in `message`, while a real `show_start` says
    //    "Start of Show: <name> joined the set at <time>". `message` is on the
    //    public read path, so a promoted marker that keeps the join wording
    //    renders a repaired show as having no start-of-show line at all.
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.startMarkerId !== null) {
        await tx
          .update(flowsheet)
          .set({ entry_type: 'show_start', message: showStartMessage(seg.djName, seg.startTime) })
          .where(eq(flowsheet.id, seg.startMarkerId));
      }

      // A segment that is genuinely still on the air has no sign-off to record.
      if (seg.endTime === null) continue;
      const endMessage = showEndMessage(seg.djName, seg.endTime);

      if (seg.endMarkerId !== null) {
        await tx
          .update(flowsheet)
          .set({ entry_type: 'show_end', message: endMessage })
          .where(eq(flowsheet.id, seg.endMarkerId));
      } else {
        // The DJ never signed off; the next go-live is the only evidence the
        // set ended. Mint the marker the sign-off would have written.
        const targetShowId = showIdForSegment(i);
        await tx.insert(flowsheet).values({
          show_id: targetShowId,
          entry_type: 'show_end',
          dj_name: seg.djName,
          add_time: seg.endTime,
          play_order: seg.entryIds.length + 1,
          message: endMessage,
        });
        log('show-end-minted', { show_id: targetShowId, dj_name: seg.djName, at: seg.endTime.toISOString() });
      }
    }

    // 5. Move each membership to the show that DJ actually ran, deactivating
    //    it where that show is closed.
    //
    //    A DJ who ran two non-adjacent segments — went live, left, came back
    //    later — has only ONE `show_djs` row on the original show, so the move
    //    can satisfy the first of their segments and nothing else: the second
    //    UPDATE matches zero rows and that show ends up with a `primary_dj_id`
    //    and no membership at all. Later segments get an explicit insert
    //    instead. `show_djs` is unique on `(show_id, dj_id)` and every target
    //    show was created moments ago, so the conflict arm is unreachable
    //    belt-and-braces.
    const movedDjs = new Set<string>();
    for (let i = 1; i < segments.length; i++) {
      const dj = segmentDjs.get(i);
      if (!dj) continue;
      const showId = showIdForSegment(i);
      const active = segments[i].endTime === null;
      if (movedDjs.has(dj.id)) {
        await tx.insert(show_djs).values({ show_id: showId, dj_id: dj.id, active }).onConflictDoNothing();
      } else {
        await tx
          .update(show_djs)
          .set({ show_id: showId, active })
          .where(and(eq(show_djs.show_id, original.id), eq(show_djs.dj_id, dj.id)));
        movedDjs.add(dj.id);
      }
    }

    // Whatever is still on the original show is either a DJ whose join was a
    // sub-threshold blip — a genuine co-host of whichever segment held their
    // marker, which step 3 already moved — or a DJ whose segment did not
    // resolve to an account, in which case there is no way to tell WHICH
    // leftover row is theirs and the move had to be skipped. The lead show is
    // closed by step 1 either way, so nothing on it should read as on the air.
    // The unresolved case is reported by `warn-unresolved-djs`, which is why
    // the run procedure requires every segment to show `resolved: true`.
    await tx.update(show_djs).set({ active: false }).where(eq(show_djs.show_id, original.id));

    // 6. If the last segment is still on the air, its `show_start` must end up
    //    as the newest marker by id, or the iOS banner blanks to "AUTO DJ".
    //    Runs last, after every mint above has already taken its id.
    const liveIndex = segments.length - 1;
    if (segments[liveIndex].endTime === null) {
      const liveShowId = liveIndex === 0 ? original.id : newShowIds.get(liveIndex)!;
      await ensureLiveShowStartIsNewestMarker(tx, liveShowId);
    }
  });
};

/**
 * Re-denormalize `flowsheet.dj_name` across one already-split show.
 *
 * Step 3b does this inline for a fresh split. This is the retroactive form,
 * for shows split before that step existed — production shows 1951225-1951228,
 * whose rows still carry `dj sue` from the 2026-08-28 run. The split cannot
 * simply be re-run over them: a second pass finds its own promoted
 * `show_start` markers where the `dj_join` boundaries were and splits nothing.
 *
 * The target name is whatever `resolveDjNameForShow` will return for the show
 * as it now stands, so this converges on the read path rather than on a value
 * this job invents. Resolution goes through the canonical `resolveShowDjName`
 * (`@wxyc/database`) rather than a re-derived COALESCE — `jobs/flowsheet-etl`'s
 * copy of that chain predates `dj_name_override` and omits the literal-
 * "Anonymous" filter, and re-deriving it here would reintroduce both.
 *
 * `dj_join` / `dj_leave` are excluded for the same reason as step 3b: those
 * markers name a PERSON arriving or leaving, not the show's DJ, so a co-host
 * blip inside the show has to keep its own handle.
 *
 * Idempotent by construction — `IS DISTINCT FROM` means an already-correct row
 * is not rewritten, so a second run reports zero.
 */
export const repairDjNameForShow = async (showId: number, dryRun: boolean): Promise<number> => {
  const show = await loadShow(showId);

  const linked =
    show.primary_dj_id == null
      ? null
      : ((await db.select({ djName: user.djName }).from(user).where(eq(user.id, show.primary_dj_id)).limit(1))[0] ??
        null);

  const djName = resolveShowDjName({
    dj_name_override: show.dj_name_override ?? null,
    legacy_dj_name: show.legacy_dj_name ?? null,
    primary_dj_id: show.primary_dj_id ?? null,
    user: linked,
  });

  const stale = and(
    eq(flowsheet.show_id, showId),
    notInArray(flowsheet.entry_type, ['dj_join', 'dj_leave']),
    sql`${flowsheet.dj_name} IS DISTINCT FROM ${djName}`
  );

  if (dryRun) {
    const rows = await db.select({ id: flowsheet.id }).from(flowsheet).where(stale);
    log('dj-name-repair-dry-run', { show_id: showId, dj_name: djName, would_update: rows.length });
    return rows.length;
  }

  const updated = await db.update(flowsheet).set({ dj_name: djName }).where(stale).returning({ id: flowsheet.id });
  log('dj-name-repaired', { show_id: showId, dj_name: djName, rows: updated.length });
  return updated.length;
};

/**
 * Re-insert the live show's `show_start` so it holds the highest marker id.
 *
 * The iOS listener app derives its on-air banner from
 * `showMarkers.max(by: { $0.id })` and renders nothing when that marker is a
 * `show_end` (`Shared/Playlist/Sources/Playlist/PlaylistEntry.swift`,
 * `onAirSignOn`). It orders by **id**, not `add_time` — so a `show_end` this
 * job mints for an EARLIER segment carries a correct `add_time` but a
 * brand-new serial id that outranks the live show's `show_start`, and the app
 * shows "AUTO DJ" while a DJ is actually on the air.
 *
 * Observed in production on the 2026-08-28 run: eureka!'s minted `show_end`
 * landed as id 5313060 against Dj xD's `show_start` at 5313038, and the
 * listener banner went blank mid-broadcast. The same id-vs-`add_time`
 * disagreement that `resolveShowEndInstant` exists to avoid, arriving from the
 * write side instead of the read side.
 *
 * Serial ids cannot be inserted between existing values, so the only way to
 * restore the invariant is to re-mint the marker that must win: delete the
 * `show_start` and insert it again with every column preserved (including
 * `legacy_entry_id`, which the mirror's loop-guard reads as "this row came
 * from tubafrenzy, do not mirror it back"). Same transaction, so the unique
 * index on `legacy_entry_id` never sees both rows.
 *
 * Nothing else keys on the row id it discards. `flowsheet_linkage_review` holds
 * the only foreign key pointing at `flowsheet.id` and it is `ON DELETE CASCADE`,
 * but it only ever queues `entry_type = 'track'` rows with ambiguous library
 * linkage, so a marker cannot have a review to lose. No job persists a flowsheet
 * id as a cursor (`flowsheet-etl` and the digests use time watermarks;
 * `flowsheet-no-match-recheck`'s `cursor_position` is an OFFSET, not an id;
 * the ghost sweep's id cursor is operator-supplied per run and a re-minted row
 * moves AHEAD of it, the safe direction), and the mirror's only durable key is
 * `legacy_entry_id`, preserved below.
 *
 * The `id DESC` "last logged entry" contract (`lastLoggedShowEntryOrderBy` in
 * `@wxyc/database`) is the one thing a re-mint moves, and moving it is the
 * point: it makes `show_start` the show's newest row, so `isLatestEntryShowEnd`
 * reads false and `closeShowFromTerminalShowEndMarker` correctly declines to
 * close a live show. That is why both callers gate on the show being open —
 * pointing this at a closed show would be a lie about which row was logged last.
 * `resolveShowEndInstant` is immune by construction: it reads `MAX(add_time)`,
 * which the re-mint preserves.
 *
 * Idempotent: a run where no `show_end` outranks the live `show_start` does
 * nothing.
 */
export const ensureLiveShowStartIsNewestMarker = async (
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  liveShowId: number
): Promise<boolean> => {
  const startRow = (
    await tx
      .select()
      .from(flowsheet)
      .where(and(eq(flowsheet.show_id, liveShowId), eq(flowsheet.entry_type, 'show_start')))
      .orderBy(asc(flowsheet.id))
      .limit(1)
  )[0];
  if (!startRow) return false;

  const newer = (
    await tx
      .select({ id: flowsheet.id })
      .from(flowsheet)
      .where(and(eq(flowsheet.entry_type, 'show_end'), gt(flowsheet.id, startRow.id)))
      // Ordered purely to pin the plan. `id > $1` is served by `flowsheet_pkey`
      // and this ORDER BY is the order that scan already returns, so it costs
      // nothing — but it takes a Seq Scan of the 1.7 GB heap off the planner's
      // menu outright rather than trusting it to keep estimating the range as
      // narrow. Worth one word inside a transaction that is not re-runnable and
      // is holding row locks on every entry of the show while this runs.
      .orderBy(asc(flowsheet.id))
      .limit(1)
  )[0];
  if (!newer) return false;

  // Every column except the serial id, which is the whole point of re-minting.
  const { id: oldId, ...columns } = startRow;

  await tx.delete(flowsheet).where(eq(flowsheet.id, oldId));
  const reinserted = await tx
    .insert(flowsheet)
    .values({
      ...columns,
      // Redundant with the spread, and deliberately so. This is a write site for
      // `flowsheet.legacy_entry_id`, and `scripts/check-legacy-entry-id-writes.mjs`
      // finds write sites by grepping for the literal `legacy_entry_id:` key —
      // carried only by a spread, this one would evade the registry that exists
      // to keep every writer of that overloaded column enumerable. It preserves
      // an existing tubafrenzy id across a physical re-mint and never mints a
      // value, so use #2's loop-guard invariant ("non-null ⇒ came from
      // tubafrenzy") is unchanged.
      legacy_entry_id: startRow.legacy_entry_id,
    })
    .returning({ id: flowsheet.id });

  log('live-show-start-reminted', {
    show_id: liveShowId,
    old_id: oldId,
    new_id: reinserted[0].id,
    outranked_by: newer.id,
  });
  return true;
};

/**
 * Stamp the original show's sign-off in tubafrenzy so the flowsheet ETL cannot
 * revert the repaired `end_time` to NULL. See the module docblock.
 */
export const mirrorSignoff = async (legacyShowId: number, endTime: Date): Promise<void> => {
  const epochMs = endTime.getTime();
  // Read the value back in the same batch. `MirrorSQL.send` returns stdout only,
  // so an UPDATE that matched zero rows is indistinguishable from one that
  // matched one — and this UPDATE is guarded on `SIGNOFF_TIME = 0`, which a show
  // in the BS#1861 "sign-off happened, end_time lagged" class does not satisfy.
  // Logging `mirror-signoff-written` unconditionally would report the guard as
  // installed when it is not, and a later manual `flowsheet-etl` run would then
  // overwrite the repaired `end_time` from tubafrenzy while the operator's log
  // said the mirror half succeeded.
  const output = await MirrorSQL.instance().send(
    `UPDATE FLOWSHEET_RADIO_SHOW_PROD SET SIGNOFF_TIME = ${epochMs} WHERE ID = ${legacyShowId} AND SIGNOFF_TIME = 0;
     SELECT SIGNOFF_TIME FROM FLOWSHEET_RADIO_SHOW_PROD WHERE ID = ${legacyShowId};`
  );
  const observed = String(output ?? '')
    .trim()
    .split(/\s+/)
    .pop();
  if (observed !== String(epochMs)) {
    throw new Error(
      `tubafrenzy SIGNOFF_TIME for show ${legacyShowId} is ${observed ?? '<no row>'}, expected ${epochMs}. ` +
        `The PostgreSQL split is ALREADY COMMITTED and cannot be re-run; only this stamp is missing. ` +
        `Reconcile by hand once you know why the row disagrees: ` +
        `UPDATE FLOWSHEET_RADIO_SHOW_PROD SET SIGNOFF_TIME = ${epochMs} WHERE ID = ${legacyShowId};`
    );
  }
  log('mirror-signoff-written', { legacy_show_id: legacyShowId, signoff_time: epochMs });
};

// ---- Entrypoint ----

export const main = async (): Promise<void> => {
  // Standalone repair for a split that already ran: re-mint the newest open
  // show's `show_start` so it outranks any `show_end` minted after it. Needed
  // because the ordering hazard was found only after the 2026-08-28 apply, and
  // re-running the split over an already-split show is not possible.
  // Retroactive `flowsheet.dj_name` repair for a show split before step 3b
  // existed. Accepts a comma-separated list so the four shows from one split
  // are one invocation; each is resolved and updated independently.
  if (process.argv.includes('--repair-dj-name')) {
    const raw = argValue('show-id');
    if (!raw || !/^\d+(,\d+)*$/.test(raw)) {
      throw new Error('Required with --repair-dj-name: --show-id=<id>[,<id>...]');
    }
    const ids = raw.split(',').map((v) => Number.parseInt(v, 10));
    let total = 0;
    for (const id of ids) {
      total += await repairDjNameForShow(id, DRY_RUN);
    }
    log(DRY_RUN ? 'dj-name-repair-dry-run-complete' : 'dj-name-repair-complete', {
      shows: ids,
      rows: total,
    });
    return;
  }

  if (process.argv.includes('--repair-marker-order')) {
    // Requires the show explicitly. An earlier cut took "the newest open show"
    // instead, which is right only when the repair runs immediately after the
    // split and quietly wrong afterwards: run it hours later and the split's
    // live tail has closed, so it no-ops against an unrelated show and still
    // logs a success. That happened on the 2026-08-28 repair, which reported
    // `repair-complete` for show 1951231 while 1951228 was the one it was
    // aimed at. A repair tool that can look like it worked when it did not is
    // worse than one that refuses.
    const targetArg = argValue('show-id');
    if (!targetArg || !/^\d+$/.test(targetArg)) {
      throw new Error('Required with --repair-marker-order: --show-id=<the show whose show_start must stay newest>');
    }
    const target = await loadShow(Number.parseInt(targetArg, 10));

    // The invariant only bites while the show is genuinely live — a blank
    // banner is the correct rendering when nothing is on the air.
    if (target.end_time !== null) {
      log('repair-noop', {
        show_id: target.id,
        reason: 'show is already closed; the newest-marker invariant only applies to an open show',
      });
      return;
    }
    if (DRY_RUN) {
      log('repair-dry-run', { show_id: target.id, note: 'no writes performed' });
      return;
    }
    const changed = await db.transaction((tx) => ensureLiveShowStartIsNewestMarker(tx, target.id));
    log('repair-complete', { show_id: target.id, reminted: changed });
    return;
  }

  const showIdArg = argValue('show-id');
  if (!showIdArg || !/^\d+$/.test(showIdArg)) {
    throw new Error('Required: --show-id=<positive integer>');
  }
  const showId = Number.parseInt(showIdArg, 10);

  const minSegmentSeconds = minSegmentSecondsArg();

  const original = await loadShow(showId);
  const entries = await loadEntries(showId);
  const { segments, ignoredBlips } = planSegments(entries, original.start_time, original.end_time, minSegmentSeconds);

  const segmentDjs = await resolveSegmentDjs(showId, segments);

  log('plan', {
    show_id: showId,
    dry_run: DRY_RUN,
    min_segment_seconds: minSegmentSeconds,
    entries: entries.length,
    segments: segments.map((s, i) => ({
      index: i,
      dj_name: s.djName,
      primary_dj_id: i === 0 ? original.primary_dj_id : (segmentDjs.get(i)?.id ?? null),
      resolved: i === 0 || segmentDjs.has(i),
      start: s.startTime.toISOString(),
      end: s.endTime?.toISOString() ?? null,
      entries: s.entryIds.length,
      // No `startMarkerId` clause: segment 0 has none by definition, and the
      // apply's mint condition does not test one either — so gating on it made
      // the dry run report `false` for the lead show in exactly the shape this
      // job exists for (1951224: `dj sue` never signed off, so the apply DOES
      // mint her `show_end`). A non-re-runnable one-shot must not understate
      // its writes in the plan the operator is told to read first.
      mints_show_end: s.endMarkerId === null && s.endTime !== null,
    })),
    ignored_blips: ignoredBlips,
  });

  const unresolved = segments.map((_, i) => i).filter((i) => i > 0 && !segmentDjs.has(i));
  if (unresolved.length > 0) {
    log('warn-unresolved-djs', {
      segments: unresolved,
      note:
        'these shows get primary_dj_id NULL and keep the handle in legacy_dj_name, reintroducing the ' +
        'legacy-name fallback this repair removes; their show_djs membership cannot be moved either, ' +
        'so an unresolved DJ who is still on the air ends up with no active membership anywhere. ' +
        'Resolve the handles (or fix auth_user.dj_name) before applying.',
    });
  }

  if (segments.length < 2) {
    log('noop', { reason: 'no dj_join boundaries above the threshold; nothing to split' });
    return;
  }

  if (DRY_RUN) {
    log('dry-run-complete', { note: 'no writes performed' });
    return;
  }

  await applySplit(original, segments, segmentDjs);

  if (!SKIP_MIRROR && original.legacy_show_id && segments[0].endTime) {
    await mirrorSignoff(original.legacy_show_id, segments[0].endTime);
  } else if (!SKIP_MIRROR) {
    log('mirror-skipped', { reason: 'show has no legacy_show_id or no resolved end instant' });
  }

  log('finished', { show_id: showId, shows_created: segments.length - 1 });
};

if (process.env.NODE_ENV !== 'test') {
  main()
    .catch((err) => {
      log('failed', { error: err instanceof Error ? err.message : String(err) });
      process.exitCode = 1;
    })
    .finally(async () => {
      MirrorSQL.instance().close();
      await closeDatabaseConnection();
    });
}
