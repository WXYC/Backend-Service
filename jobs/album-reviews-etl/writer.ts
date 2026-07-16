/**
 * DB writer for album-reviews-etl. Same shape as the triangle-shows-etl
 * writer (typed insert builder — the BS#1068 `'{...}'::text[]` literal
 * trap and the BS#802 Date-through-raw-template trap both only bite raw
 * `sql\`\`` templates), UPSERTing one row per form submission keyed on the
 * partial-unique `source_key` (migration 0119).
 *
 * Writer discipline:
 *
 *  1. `add_date` is INSERT-only (omitted from `values` AND the ON CONFLICT
 *     `set`): the schema's DEFAULT now() stamps the import date once, and
 *     its omission preserves the forward-only anchor — the
 *     `first_scraped_at` idiom (BS#1385).
 *  2. `album_id` is NEVER written here — the link pass owns it (guarded
 *     `WHERE album_id IS NULL` over there), so a sheet edit can never
 *     clobber a link and links are never overwritten.
 *  3. `setWhere` carries an IS DISTINCT FROM guard over every content
 *     column, so a no-op nightly run against an unchanged sheet skips the
 *     UPDATE entirely and `last_modified` stays an honest audit signal
 *     (the venues-writer idiom). The suppressed UPDATE returns no row —
 *     reported as `unchanged`.
 *  4. Rows are never deleted: a row vanishing from the sheet leaves the DB
 *     row untouched (org data-safety rule).
 *
 * `xmax = 0` in `returning` distinguishes inserted from updated for the
 * run counters.
 */

import { db, album_review_submissions } from '@wxyc/database';
import { sql } from 'drizzle-orm';

import type { SubmissionContent } from './map.js';

export type UpsertOutcome = {
  inserted: boolean;
  updated: boolean;
  unchanged: boolean;
};

/**
 * The content columns the ON CONFLICT `set` refreshes (and the setWhere
 * guard compares) — exactly the `SubmissionContent` keys minus
 * `source_key` (the conflict target; equal on both sides by definition).
 * Exported so the writer test can pin the list against the map shape:
 * a column added to `SubmissionContent` but forgotten here would silently
 * stop propagating sheet edits for that column.
 */
export const SET_CONTENT_COLUMNS = [
  'artist_name',
  'album_title',
  'record_label',
  'artist_blurb',
  'review',
  'recommended_tracks',
  'buzzwords',
  'fcc_violations',
  'review_purpose',
  'reviewer_raw',
  'social_consent_raw',
  'social_consent',
  'released_within_six_months',
  'rotated',
  'submitted_at',
  'source',
  'norm_artist',
  'norm_album',
] as const;

/**
 * UPSERT one mapped submission. Idempotent on `source_key`; see the module
 * docstring for the set/setWhere discipline.
 */
export const upsertSubmission = async (content: SubmissionContent): Promise<UpsertOutcome> => {
  const t = album_review_submissions;

  const result = await db
    .insert(t)
    .values(content)
    .onConflictDoUpdate({
      target: t.source_key,
      // The 0119 unique index is partial — the conflict target must name
      // its predicate or PG can't match the arbiter index.
      targetWhere: sql`${t.source_key} IS NOT NULL`,
      set: {
        artist_name: content.artist_name,
        album_title: content.album_title,
        record_label: content.record_label,
        artist_blurb: content.artist_blurb,
        review: content.review,
        recommended_tracks: content.recommended_tracks,
        buzzwords: content.buzzwords,
        fcc_violations: content.fcc_violations,
        review_purpose: content.review_purpose,
        reviewer_raw: content.reviewer_raw,
        social_consent_raw: content.social_consent_raw,
        social_consent: content.social_consent,
        released_within_six_months: content.released_within_six_months,
        rotated: content.rotated,
        submitted_at: content.submitted_at,
        source: content.source,
        norm_artist: content.norm_artist,
        norm_album: content.norm_album,
        last_modified: sql`now()`,
      },
      // Skip the UPDATE when nothing changed so `last_modified` stays an
      // honest audit signal instead of ticking every nightly run. One arm
      // per content column — must stay in lockstep with `set` above (the
      // writer test pins the arm count to SET_CONTENT_COLUMNS.length).
      setWhere: sql`${t.artist_name} IS DISTINCT FROM ${content.artist_name}
        OR ${t.album_title} IS DISTINCT FROM ${content.album_title}
        OR ${t.record_label} IS DISTINCT FROM ${content.record_label}
        OR ${t.artist_blurb} IS DISTINCT FROM ${content.artist_blurb}
        OR ${t.review} IS DISTINCT FROM ${content.review}
        OR ${t.recommended_tracks} IS DISTINCT FROM ${content.recommended_tracks}
        OR ${t.buzzwords} IS DISTINCT FROM ${content.buzzwords}
        OR ${t.fcc_violations} IS DISTINCT FROM ${content.fcc_violations}
        OR ${t.review_purpose} IS DISTINCT FROM ${content.review_purpose}
        OR ${t.reviewer_raw} IS DISTINCT FROM ${content.reviewer_raw}
        OR ${t.social_consent_raw} IS DISTINCT FROM ${content.social_consent_raw}
        OR ${t.social_consent} IS DISTINCT FROM ${content.social_consent}
        OR ${t.released_within_six_months} IS DISTINCT FROM ${content.released_within_six_months}
        OR ${t.rotated} IS DISTINCT FROM ${content.rotated}
        OR ${t.submitted_at} IS DISTINCT FROM ${content.submitted_at}
        OR ${t.source} IS DISTINCT FROM ${content.source}
        OR ${t.norm_artist} IS DISTINCT FROM ${content.norm_artist}
        OR ${t.norm_album} IS DISTINCT FROM ${content.norm_album}`,
    })
    .returning({
      id: t.id,
      // xmax = 0 on the row this transaction INSERTed; non-zero when the
      // ON CONFLICT UPDATE path fired.
      inserted: sql<boolean>`xmax = 0`,
    });

  if (result.length === 0) {
    // setWhere suppressed a no-op UPDATE — the row exists and matches.
    return { inserted: false, updated: false, unchanged: true };
  }
  return result[0].inserted
    ? { inserted: true, updated: false, unchanged: false }
    : { inserted: false, updated: true, unchanged: false };
};
