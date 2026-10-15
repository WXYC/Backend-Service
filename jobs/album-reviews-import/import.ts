/**
 * Importable core of the one-shot album-reviews import (BS#3132): copies linked form-archive rows into `reviews` on
 * their release, once, with the imported text as revision 1. Which rows it skips is set out in ADR 0011 (docs/adr/0011-album-review-submissions-separate-archive.md).
 *
 * Takes the postgres.js handle from its caller so the integration spec can run this exact module (`dist/import.cjs`)
 * against a real Postgres. It cannot call `apps/backend`'s `writeFirstRevisionIfMissing`, so it writes revision 1 with
 * the values that function would: the five content fields, `edited_by` the review's author, `edited_at` the form's
 * `submitted_at`. Only inserts; a dry run reads in a read-only transaction.
 */

import { AUTHOR_MAX, FILED_STATES } from '@wxyc/database';
import type { Sql } from 'postgres';

/** Why an archive row is not imported (rules: docs/adr/0011-album-review-submissions-separate-archive.md). A row is reported under the FIRST reason that applies, in this order. */
export const SKIP_REASONS = [
  'no_release',
  'blank_review',
  'cited_by_intake_item',
  'already_imported',
  'author_too_long',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface ImportResult {
  status: 'dry-run' | 'applied';
  /** Rows that pass the first three skip rules (the README's counter definitions): everything the job could import. */
  eligible: number;
  /** Rows written; in a dry run, the rows an `--apply` would write. */
  imported: number;
  skipped: Record<SkipReason, number>;
  /** Eligible rows refused for an over-long author: the README sends these to a hand decision. */
  tooLongAuthors: number[];
}

interface ArchiveRow {
  id: number;
  album_id: number | null;
  review: string | null;
  reviewer_raw: string | null;
  cited: boolean;
  imported: boolean;
}

/** The two reasons that still count a row as eligible (the README's counter definitions). */
const isEligibleReason = (reason: SkipReason) => reason === 'already_imported' || reason === 'author_too_long';

/** The author as it would be stored: `reviewer_raw`, trimmed; null when blank. */
const authorOf = (row: ArchiveRow) => row.reviewer_raw?.trim() || null;

/** The first applicable reason, or null when the row is importable. */
export const skipReason = (row: ArchiveRow): SkipReason | null => {
  if (row.album_id === null) return 'no_release';
  if ((row.review ?? '').trim() === '') return 'blank_review';
  if (row.cited) return 'cited_by_intake_item';
  if (row.imported) return 'already_imported';
  // Postgres counts characters, not UTF-16 units, so count code points (`snapshotAuthor` does).
  if ([...(authorOf(row) ?? '')].length > AUTHOR_MAX) return 'author_too_long';
  return null;
};

/**
 * One line for the operator's terminal from a caught error. A postgres.js error carries the server's `detail`
 * (`Failing row contains (...)`) and `where`, and a data exception's `message` (SQLSTATE class 22) quotes the value; any
 * of them can hold a reviewer's name or a review's text, which docs/pii.md keeps out of logs. So a database error is
 * reported by its SQLSTATE, the names of what it was raised against and, unless it is a data exception, its message.
 */
export const describeError = (err: unknown): string => {
  if (!(err instanceof Error)) return 'a value that is not an Error was thrown';
  const pg = err as Partial<Record<'severity' | 'code' | 'table_name' | 'column_name' | 'constraint_name', string>>;
  if (pg.severity === undefined) return `${err.name}: ${err.message}`;
  const named = [pg.table_name, pg.column_name, pg.constraint_name].filter(Boolean).join(' ');
  return `${err.name} ${pg.code}${pg.code?.startsWith('22') ? '' : `: ${err.message}`}${named ? ` (${named})` : ''}`;
};

export const runImport = async (
  sql: Sql,
  { schema, apply, log = console.log }: { schema: string; apply: boolean; log?: (line: string) => void }
): Promise<ImportResult> => {
  const result: ImportResult = {
    status: apply ? 'applied' : 'dry-run',
    eligible: 0,
    imported: 0,
    skipped: Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<SkipReason, number>,
    tooLongAuthors: [],
  };
  await sql.begin(apply ? 'read write' : 'read only', async (tx) => {
    const t = (table: string) => tx`${tx(schema)}.${tx(table)}`;
    // `cited`: an intake item cites this row and is unfiled or filed as its release (docs/adr/0011-album-review-submissions-separate-archive.md).
    const rows = await tx<ArchiveRow[]>`
      SELECT s.id, s.album_id, s.review, s.reviewer_raw,
             EXISTS (SELECT 1 FROM ${t('intake_items')} i WHERE i.cited_submission_id = s.id
                        AND (i.state NOT IN ${tx(FILED_STATES)} OR i.album_id = s.album_id)) AS cited,
             EXISTS (SELECT 1 FROM ${t('reviews')} r WHERE r.imported_from_submission_id = s.id) AS imported
        FROM ${t('album_review_submissions')} s
       ORDER BY s.id`;
    for (const row of rows) {
      const reason = skipReason(row);
      if (reason !== null && !isEligibleReason(reason)) {
        result.skipped[reason] += 1;
        continue;
      }
      result.eligible += 1;
      if (reason !== null) {
        result.skipped[reason] += 1;
        if (reason === 'author_too_long') result.tooLongAuthors.push(row.id);
        continue;
      }
      if (apply) {
        // The partial unique index is the backstop for a concurrent run: a conflict writes nothing, revision included.
        // `s.album_id IS NOT NULL` is the backstop for a release deleted since the scan (`ON DELETE SET NULL`): the
        // insert would fail `reviews_target_ck` and abort the run, so it writes nothing instead.
        const written = await tx`
          WITH imported AS (
            INSERT INTO ${t('reviews')} (album_id, review, artist_blurb, recommended_tracks, buzzwords, fcc, author,
                                         submitted_at, add_date, publish_website, publish_apps, publish_instagram,
                                         credit, imported_from_submission_id)
            SELECT s.album_id, s.review, s.artist_blurb, s.recommended_tracks, s.buzzwords, s.fcc_violations,
                   ${authorOf(row)}::text, s.submitted_at,
                   COALESCE((s.submitted_at AT TIME ZONE 'America/New_York')::date, CURRENT_DATE),
                   s.social_consent IS TRUE, s.social_consent IS TRUE, s.social_consent IS TRUE, 'none', s.id
              FROM ${t('album_review_submissions')} s WHERE s.id = ${row.id} AND s.album_id IS NOT NULL
            ON CONFLICT (imported_from_submission_id) WHERE imported_from_submission_id IS NOT NULL DO NOTHING
            RETURNING *)
          INSERT INTO ${t('review_revisions')} (review_id, revision, edited_by, edited_by_user_id, edited_at, review,
                                                artist_blurb, buzzwords, recommended_tracks, fcc)
          SELECT id, 1, author, NULL, COALESCE(submitted_at, now()), review, artist_blurb, buzzwords,
                 recommended_tracks, fcc
            FROM imported
          RETURNING review_id`;
        if (written.length === 0) {
          // Nothing written: a concurrent run took the row, or its release was deleted since the scan.
          const [{ linked }] = await tx<{ linked: boolean }[]>`
            SELECT EXISTS (SELECT 1 FROM ${t('album_review_submissions')} WHERE id = ${row.id} AND album_id IS NOT NULL) AS linked`;
          result.skipped[linked ? 'already_imported' : 'no_release'] += 1;
          continue;
        }
      }
      result.imported += 1;
    }
  });
  const skipped = SKIP_REASONS.map((reason) => `${reason}=${result.skipped[reason]}`).join(' ');
  log(
    `[album-reviews-import] ${result.status}: eligible=${result.eligible} imported=${result.imported} skipped: ${skipped}`
  );
  if (result.tooLongAuthors.length > 0) {
    log(
      `[album-reviews-import] author over ${AUTHOR_MAX} code points, needs a hand decision: ids ${result.tooLongAuthors.join(', ')}`
    );
  }
  return result;
};
