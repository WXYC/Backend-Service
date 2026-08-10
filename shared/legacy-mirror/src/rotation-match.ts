/**
 * Active-rotation fallback helper for the tubafrenzy mirror write path.
 *
 * When a DJ types an entry by hand instead of using the rotation picker,
 * `flowsheet.rotation_id` stays NULL even when the (artist, album) matches
 * an active rotation row. Without this helper the mirror sends
 * `flowsheetEntryType=0`, tubafrenzy's `FlowsheetEntry.isRotation()` returns
 * false, and the entry shows unbadged on wxyc.info.
 *
 * Three-cohort match mirrors BS#1362's read-path COALESCE subquery at the
 * cohort level. See apps/backend/services/flowsheet.service.ts
 * FSEntryFieldsRaw.rotation_bin for the read-path reference implementation.
 *
 * Known shape differences from the read-path subquery (kept in sync at the
 * cohort/predicate level, not literally):
 *   - Aggregation: this helper wraps as `SELECT EXISTS(...)` (returns
 *     boolean); read path uses `SELECT t.rotation_bin ... ORDER BY t.id
 *     LIMIT 1` over a UNION ALL (returns the bin letter). The write path only
 *     needs a boolean to decide flowsheetEntryType=2 vs fall-through, so no
 *     tie-break is needed here.
 *   - Arm shape (BS#2080): the read path's three cohorts are now a `UNION ALL`
 *     of three separately-indexable probes, because the OR spanned three
 *     tables and no index could serve it — see migration 0145. This helper
 *     still uses the OR form. That is deliberate for now: it runs once per
 *     hand-typed entry on the live write path, not once per row of a windowed
 *     read, so it never hit the multiplier that made the read path time out.
 *     It does still pay the full 239-buffer / ~11.7 ms cold seq scan of
 *     `rotation` per call, and the two new indexes cannot help it while it
 *     stays an OR. Converting it is tracked separately; if you do, keep the
 *     cohort semantics identical to the read path and re-check this list.
 *   - Arm (c) join type (BS#2080): the read path's third cohort now uses inner
 *     JOINs where this helper still uses LEFT JOINs. They agree except when
 *     the entry's artist AND album both trim to '', where the LEFT JOIN form
 *     matches the NULL side of every library-less active rotation row and
 *     returns a badge. The read path deliberately no longer does; this helper
 *     still would.
 *   - Gate: read-path's outer CASE uses `${flowsheet.rotation_id} IS NULL`;
 *     this helper's JS guard matches via `entry.rotation_id == null` so
 *     non-NULL values (including 0 and negatives, theoretical but
 *     representable) skip the fallback — aligned with the read path.
 *   - Empty-name guard: applied against the raw input value (no JS-side
 *     trim) so the SQL `lower(trim(coalesce(col, '')))` on both sides
 *     stays the single normalizer. JS `String.prototype.trim()` is broader
 *     than PG's `trim()` (strips Unicode whitespace like NBSP); pre-
 *     trimming on the JS side would fork the comparison key.
 */

import { db, rotation, library, artists } from '@wxyc/database';
import { sql } from 'drizzle-orm';
import { captureMirrorFailure } from './http-mirror.js';

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
 * The rotation window is bounded on both sides against `add_time` so historical
 * shows are classified using the rotation state at the time of the play, not now:
 * `add_date <= add_time` (inclusive lower bound — a play before the release
 * entered rotation is not matched; BS#1526) and `kill_date IS NULL OR
 * kill_date > add_time` (exclusive upper bound).
 *
 * Returns false immediately — without querying the DB — when:
 *   - `rotation_id` is non-NULL (matches the read-path `IS NULL` gate; the
 *     primary FK path handles those entries)
 *   - `artist_name` or `album_title` is missing or the empty string (no
 *     cohort can fire meaningfully; mirrors the read-path's outer
 *     `coalesce(col, '') <> ''` guard)
 *
 * On DB error, captures to Sentry at `warning` level (with `category=db`
 * via captureMirrorFailure) and returns false so the caller falls through
 * to the existing album_id → type-6 branch.
 */
export async function isActiveRotationMatch(entry: RotationMatchEntry): Promise<boolean> {
  // Read-path parity: gate on IS NULL only. A non-NULL rotation_id —
  // including 0 or any negative drift — means the FK lane already owns
  // this row; skip the fallback so the two surfaces classify it the same
  // way. BS#1432 round-2 review tightened this from `> 0` to match the
  // read-path subquery's `${flowsheet.rotation_id} IS NULL` semantic.
  if (entry.rotation_id != null) return false;

  // Outer empty-guard on the raw input, mirroring read-path's
  // `coalesce(col, '') <> ''`. JS-side trim is deliberately NOT applied
  // here: PG's `trim()` strips only ASCII space, but JS
  // `String.prototype.trim()` also strips Unicode whitespace (NBSP
  // U+00A0, U+2028, ...). Pre-trimming on the JS side would normalize one
  // side of the comparison more aggressively than the SQL `lower(trim(
  // coalesce(col, '')))` on the other, forking the match key on rotation
  // rows bulk-loaded from CSV sources that occasionally carry a leading
  // NBSP.
  const artistName = entry.artist_name ?? '';
  const albumTitle = entry.album_title ?? '';
  if (artistName === '' || albumTitle === '') return false;

  // Use `!= null` (not a falsy check) so epoch 0 (1970-01-01) is treated
  // as a real timestamp, not "no add_time". flowsheet.add_time is NOT
  // NULL with a NOW() default in the schema, so the new-Date fallback is
  // purely defensive against a caller that passes undefined.
  const addTime = entry.add_time != null ? new Date(entry.add_time as Date | string | number) : new Date();
  // Pre-stringify once: binding a raw JS `Date` into a `sql`` template
  // reaches postgres-js's outbound `Buffer.byteLength(date)` and throws
  // (BS#1821 — Drizzle rebinds the date-family serializer to a passthrough).
  // `::timestamptz::date` (not a bare `::date`) matches the read path's cast
  // of the `flowsheet.add_time` column reference (flowsheet.service.ts) —
  // that column is already `timestamptz`, so casting it straight to `::date`
  // implicitly goes through the session timezone; casting an ISO string
  // (always UTC-offset per `toISOString()`) straight to `::date` would
  // instead parse it as a literal calendar date, ignoring session tz. The
  // explicit `::timestamptz` hop keeps both paths' day-bucketing identical
  // regardless of session tz.
  const addTimeIso = addTime.toISOString();

  try {
    const albumIdCohort = entry.album_id != null ? sql`r2.album_id = ${entry.album_id}` : sql`false`;

    // Cohort SQL matches the read-path subquery's WHERE clause at the
    // cohort/predicate level (`FSEntryFieldsRaw.rotation_bin` in
    // apps/backend/services/flowsheet.service.ts — search for the symbol
    // rather than a line number, which rots). Since BS#2080 the read path
    // expresses these same three cohorts as a UNION ALL rather than an OR;
    // see the header for the full difference list. Bound values
    // (artistName, albumTitle) are non-null JS strings post `?? ''` plus
    // the empty-guard above, so no inner `coalesce(..., '')` is needed on
    // the JS-bound side — matches the read path's column-ref shape exactly.
    const result = await db.execute(sql`
      SELECT EXISTS(
        SELECT 1
        FROM ${rotation} r2
        LEFT JOIN ${library} l2 ON l2.id = r2.album_id
        LEFT JOIN ${artists} a2 ON a2.id = l2.artist_id
        WHERE r2.add_date <= ${addTimeIso}::timestamptz::date
          AND (r2.kill_date IS NULL OR r2.kill_date > ${addTimeIso}::timestamptz::date)
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

    // `=== true` (strict equality). postgres-js registers an OID 16
    // (boolean) parser `parse: x => x === 't'` in types.js that converts
    // the wire bytes 't'/'f' to JS true/false in the DataRow handler
    // before the result ever reaches application code. `SELECT EXISTS(...)`
    // always returns a JS boolean — never integer 1, string 't', or any
    // other shape. Truthy coercion (`!!`) would have been semantically
    // equivalent today, but `!!('f')` === true: if the driver ever stopped
    // applying the OID 16 parser, a string 'f' would produce a false
    // positive. `=== true` is both correct for the current driver and safe
    // against that future regression. The test suite has a 'f' → false
    // canary that would fail loudly if the driver shape changes.
    const match = (result as unknown as Array<{ match: unknown }>)[0]?.match;
    return match === true;
  } catch (e) {
    captureMirrorFailure('rotation_lookup', { error: e }, 'warning');
    return false;
  }
}
