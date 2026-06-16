/**
 * Active-rotation fallback helper for the tubafrenzy mirror write path.
 *
 * When a DJ types an entry by hand instead of using the rotation picker,
 * `flowsheet.rotation_id` stays NULL even when the (artist, album) matches
 * an active rotation row. Without this helper the mirror sends
 * `flowsheetEntryType=0`, tubafrenzy's `FlowsheetEntry.isRotation()` returns
 * false, and the entry shows unbadged on wxyc.info.
 *
 * Three-cohort match mirrors BS#1362's read-path COALESCE subquery exactly so
 * the two surfaces stay in sync. See apps/backend/services/flowsheet.service.ts
 * FSEntryFieldsRaw.rotation_bin for the read-path reference implementation.
 */

import { db, rotation, library, artists } from '@wxyc/database';
import { sql } from 'drizzle-orm';
import { captureMirrorFailure } from './http.mirror.js';

export interface RotationMatchEntry {
  rotation_id?: number | null;
  album_id?: number | null;
  artist_name?: string | null;
  album_title?: string | null;
  add_time?: Date | string | number | null;
}

/**
 * Returns true when the entry matches an active rotation row via any of three
 * cohorts, mirroring the COALESCE fallback on the read path (BS#1362):
 *   (a) `flowsheet.album_id = rotation.album_id` (library-linked rows)
 *   (b) (artist_name, album_title) matches rotation's denormalized snapshot
 *   (c) (artist_name, album_title) matches through library + artists join
 *
 * `kill_date` is compared against `add_time` so historical shows are
 * classified using the rotation state at the time of the play, not now.
 *
 * Returns false immediately — without querying the DB — when:
 *   - `rotation_id` is set (the primary FK path handles those entries)
 *   - `artist_name` or `album_title` is empty (no cohort can fire meaningfully;
 *     mirrors the `artist_name <> '' AND album_title <> ''` guard on the
 *     read-path CASE WHEN)
 *
 * On DB error, captures to Sentry at `warning` level and returns false so the
 * caller falls through to the existing album_id → type-6 branch.
 */
export async function isActiveRotationMatch(entry: RotationMatchEntry): Promise<boolean> {
  if (entry.rotation_id != null && entry.rotation_id > 0) return false;

  const artistName = (entry.artist_name ?? '').trim();
  const albumTitle = (entry.album_title ?? '').trim();
  if (artistName.length === 0 || albumTitle.length === 0) return false;

  const addTime = entry.add_time ? new Date(entry.add_time as Date | string | number) : new Date();

  try {
    const albumIdCohort = entry.album_id != null ? sql`r2.album_id = ${entry.album_id}` : sql`false`;

    const result = await db.execute(sql`
      SELECT EXISTS(
        SELECT 1
        FROM ${rotation} r2
        LEFT JOIN ${library} l2 ON l2.id = r2.album_id
        LEFT JOIN ${artists} a2 ON a2.id = l2.artist_id
        WHERE (r2.kill_date IS NULL OR r2.kill_date > ${addTime}::date)
          AND (
            ${albumIdCohort}
            OR (
              lower(trim(coalesce(r2.artist_name, ''))) = lower(trim(${artistName}))
              AND lower(trim(coalesce(r2.album_title, ''))) = lower(trim(${albumTitle}))
            )
            OR (
              lower(trim(coalesce(a2.artist_name, ''))) = lower(trim(${artistName}))
              AND lower(trim(coalesce(l2.album_title, ''))) = lower(trim(${albumTitle}))
            )
          )
      ) AS match
    `);

    return (result as unknown as Array<{ match: boolean }>)[0]?.match === true;
  } catch (e) {
    captureMirrorFailure('rotation_lookup', { error: e }, 'warning');
    return false;
  }
}
