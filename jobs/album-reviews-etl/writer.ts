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
 * SINGLE SOURCE OF TRUTH: `SET_CONTENT_COLUMNS` drives BOTH the ON
 * CONFLICT `set` object and the `setWhere` arms by construction — the
 * three-parallel-hand-maintained-lists failure mode (a column added to
 * one list but not another silently freezing that column's propagation,
 * or churning last_modified on no-op runs) cannot occur.
 *
 * The `submitted_at` arm casts its bound param to `timestamptz`
 * explicitly: a JS Date bound through a raw sql fragment is the exact
 * BS#802 trap the module header cites — without the cast the comparison
 * can degrade to text/unknown typing at the driver boundary. Pinned end
 * to end by `tests/integration/album-reviews-writer.spec.js`.
 *
 * `xmax = 0` in `returning` distinguishes inserted from updated for the
 * run counters.
 */

import { db, album_review_submissions } from '@wxyc/database';
import { sql, type SQL } from 'drizzle-orm';

import type { SubmissionContent } from './map.js';

export type UpsertOutcome = {
  inserted: boolean;
  updated: boolean;
  unchanged: boolean;
};

/**
 * The content columns the ON CONFLICT `set` refreshes and the `setWhere`
 * guard compares — exactly the `SubmissionContent` keys minus
 * `source_key` (the conflict target; equal on both sides by definition).
 * `satisfies` pins every entry to a real `SubmissionContent` key at
 * compile time; the writer test pins the missing-key direction (list ==
 * content keys minus source_key), so map/writer drift fails CI.
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
] as const satisfies readonly (keyof SubmissionContent)[];

type ContentColumn = (typeof SET_CONTENT_COLUMNS)[number];

/** The ON CONFLICT `set`: every content column from the single source of
 *  truth, plus the SQL-side `last_modified` refresh. */
const buildConflictSet = (
  content: SubmissionContent
): { [K in ContentColumn]: SubmissionContent[K] } & {
  last_modified: SQL;
} => ({
  ...(Object.fromEntries(SET_CONTENT_COLUMNS.map((col) => [col, content[col]])) as {
    [K in ContentColumn]: SubmissionContent[K];
  }),
  last_modified: sql`now()`,
});

/** One IS DISTINCT FROM arm per content column. `submitted_at` binds a JS
 *  Date, so its param carries an explicit `::timestamptz` cast (BS#802 —
 *  see module docstring). */
const distinctFromArm = (col: ContentColumn, content: SubmissionContent): SQL => {
  const column = album_review_submissions[col];
  if (col === 'submitted_at') {
    return sql`${column} IS DISTINCT FROM ${content.submitted_at}::timestamptz`;
  }
  return sql`${column} IS DISTINCT FROM ${content[col]}`;
};

/** OR-join of the per-column arms, derived from SET_CONTENT_COLUMNS.
 *  Built by reduction rather than `sql.join` — the alias-consumer writer
 *  test documents that drizzle's compiled `sql.join` doesn't survive
 *  ts-jest's transform. */
const buildSetWhere = (content: SubmissionContent): SQL =>
  SET_CONTENT_COLUMNS.map((col) => distinctFromArm(col, content)).reduce((acc, arm) => sql`${acc} OR ${arm}`);

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
      set: buildConflictSet(content),
      // Skip the UPDATE when nothing changed so `last_modified` stays an
      // honest audit signal instead of ticking every nightly run.
      setWhere: buildSetWhere(content),
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
