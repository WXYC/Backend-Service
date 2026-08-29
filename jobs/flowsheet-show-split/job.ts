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

import { and, asc, eq } from 'drizzle-orm';
import { db, closeDatabaseConnection, MirrorSQL, flowsheet, show_djs, shows, user } from '@wxyc/database';
import { planSegments, type Segment, type SplitEntry } from './segment.js';

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
 */
export const MIN_SEGMENT_SECONDS = Number(argValue('min-segment-seconds') ?? 120);

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
    add_time: new Date(r.add_time as unknown as string),
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

  const byHandle = new Map(members.filter((m) => m.djName).map((m) => [m.djName!.trim().toLowerCase(), m]));

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

    // 3. Re-point entries and renumber play_order from 1 within each show, so
    //    a split show reads like one that started normally rather than one
    //    beginning at play_order 106.
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const targetShowId = i === 0 ? original.id : newShowIds.get(i)!;
      for (let n = 0; n < seg.entryIds.length; n++) {
        await tx
          .update(flowsheet)
          .set({ show_id: targetShowId, play_order: n + 1 })
          .where(eq(flowsheet.id, seg.entryIds[n]));
      }
    }

    // 4. Promote the boundary markers. `dj_join` / `dj_leave` carry their
    //    content in `dj_name` and no `message`, which is the same shape the
    //    tubafrenzy-mirrored `show_start` rows already have — so the type flip
    //    alone is the whole conversion.
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.startMarkerId !== null) {
        await tx.update(flowsheet).set({ entry_type: 'show_start' }).where(eq(flowsheet.id, seg.startMarkerId));
      }
      if (seg.endMarkerId !== null) {
        await tx.update(flowsheet).set({ entry_type: 'show_end' }).where(eq(flowsheet.id, seg.endMarkerId));
      } else if (seg.endTime !== null) {
        // The DJ never signed off; the next go-live is the only evidence the
        // set ended. Mint the marker the sign-off would have written.
        const targetShowId = i === 0 ? original.id : newShowIds.get(i)!;
        await tx.insert(flowsheet).values({
          show_id: targetShowId,
          entry_type: 'show_end',
          dj_name: seg.djName,
          add_time: seg.endTime,
          play_order: seg.entryIds.length + 1,
        });
        log('show-end-minted', { show_id: targetShowId, dj_name: seg.djName, at: seg.endTime.toISOString() });
      }
    }

    // 5. Move each membership to the show that DJ actually ran, deactivating
    //    it where that show is closed.
    for (let i = 1; i < segments.length; i++) {
      const dj = segmentDjs.get(i);
      if (!dj) continue;
      await tx
        .update(show_djs)
        .set({ show_id: newShowIds.get(i)!, active: segments[i].endTime === null })
        .where(and(eq(show_djs.show_id, original.id), eq(show_djs.dj_id, dj.id)));
    }

    // Any membership still on the original show belongs to a DJ whose join was
    // a sub-threshold blip — they really were a co-host of whichever segment
    // held their marker, and step 3 already moved that marker. Deactivate the
    // stale membership so the lead show doesn't report them as on the air.
    await tx.update(show_djs).set({ active: false }).where(eq(show_djs.show_id, original.id));
  });
};

/**
 * Stamp the original show's sign-off in tubafrenzy so the flowsheet ETL cannot
 * revert the repaired `end_time` to NULL. See the module docblock.
 */
export const mirrorSignoff = async (legacyShowId: number, endTime: Date): Promise<void> => {
  const epochMs = endTime.getTime();
  await MirrorSQL.instance().send(
    `UPDATE FLOWSHEET_RADIO_SHOW_PROD SET SIGNOFF_TIME = ${epochMs} WHERE ID = ${legacyShowId} AND SIGNOFF_TIME = 0;`
  );
  log('mirror-signoff-written', { legacy_show_id: legacyShowId, signoff_time: epochMs });
};

// ---- Entrypoint ----

export const main = async (): Promise<void> => {
  const showIdArg = argValue('show-id');
  if (!showIdArg || !/^\d+$/.test(showIdArg)) {
    throw new Error('Required: --show-id=<positive integer>');
  }
  const showId = Number.parseInt(showIdArg, 10);

  const original = await loadShow(showId);
  const entries = await loadEntries(showId);
  const { segments, ignoredBlips } = planSegments(
    entries,
    new Date(original.start_time),
    original.end_time ? new Date(original.end_time) : null,
    MIN_SEGMENT_SECONDS
  );

  const segmentDjs = await resolveSegmentDjs(showId, segments);

  log('plan', {
    show_id: showId,
    dry_run: DRY_RUN,
    entries: entries.length,
    segments: segments.map((s, i) => ({
      index: i,
      dj_name: s.djName,
      primary_dj_id: i === 0 ? original.primary_dj_id : (segmentDjs.get(i)?.id ?? null),
      resolved: i === 0 || segmentDjs.has(i),
      start: s.startTime.toISOString(),
      end: s.endTime?.toISOString() ?? null,
      entries: s.entryIds.length,
      mints_show_end: s.startMarkerId !== null && s.endMarkerId === null && s.endTime !== null,
    })),
    ignored_blips: ignoredBlips,
  });

  const unresolved = segments.map((_, i) => i).filter((i) => i > 0 && !segmentDjs.has(i));
  if (unresolved.length > 0) {
    log('warn-unresolved-djs', {
      segments: unresolved,
      note: 'these shows get primary_dj_id NULL and keep the handle in legacy_dj_name',
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
